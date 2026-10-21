import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { recoverPlatformInstallation } from '../src/platform-transaction.js';
import { bundleDigest, macOSJournal, recoverMacOSBundle, withMacOSBundleTransaction } from '../src/macos-transaction.js';
import { assertCursorClosed, inspectMacOSSignature, macOSBundle, signMacOSBundle } from '../src/macos-signing.js';
import { compatibilityState, INSTALLATION_RECEIPT } from '../src/compatibility-state.js';
import { writeInstallationManifest, validateInstallation } from '../src/installation-state.js';

const originalEntitlements = { 'com.apple.security.cs.allow-jit': true, 'com.apple.security.device.camera': true };
function fakeNative({ failSign = false, running = '', failFinal = false, entitlements = originalEntitlements } = {}) {
  let signed = false, verifies = 0;
  const calls = [];
  const run = (cmd, args, options = {}) => {
    calls.push({ cmd, args });
    if (cmd.endsWith('/ps')) return running;
    if (cmd.endsWith('/ditto')) { cpSync(args.at(-2), args.at(-1), { recursive: true, preserveTimestamps: true }); return ''; }
    if (cmd.endsWith('/plutil')) {
      if (!options.input) return JSON.stringify({ CFBundleExecutable: 'Cursor', CFBundleIdentifier: 'com.todesktop.230313mzl4w4u92', CFBundleShortVersionString: '3.26.13' });
      if (args[1] === 'json') return options.input.slice(6, -8);
      return `<?xml>${options.input}</plist>`;
    }
    if (cmd.endsWith('/codesign')) {
      if (args[0] === '--force') {
        if (failSign) throw Error('injected codesign failure');
        writeFileSync(join(args.at(-1), 'Contents/_CodeSignature/CodeResources'), 'new native signature');
        signed = true; return '';
      }
      if (args[0] === '--verify') { verifies++; if (failFinal && verifies > 1) throw Error('injected final signature failure'); return ''; }
      if (args.includes('--entitlements')) return `diagnostic line\n<?xml>${JSON.stringify({ ...entitlements, ...(signed ? { 'com.apple.security.cs.disable-library-validation': true } : {}) })}</plist>`;
      return 'Signature=adhoc\nflags=0x10002(adhoc,runtime)';
    }
    throw Error('unexpected command');
  };
  return { run, calls };
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'ccursor-macos-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bundle = join(root, 'Cursor with spaces.app'), appRoot = join(bundle, 'Contents/Resources/app'), configDir = join(root, 'configuration');
  const paths = { appRoot, cursorVersion: '3.26.13', productJson: join(appRoot, 'product.json'), workbenchJs: join(appRoot, 'out/workbench.js'),
    cursor2plusDir: join(appRoot, 'extensions/cursor2plus') };
  for (const [path, body] of [
    [join(bundle, 'Contents/Info.plist'), 'native-info'], [join(bundle, 'Contents/MacOS/Cursor'), 'native executable'],
    [join(bundle, 'Contents/_CodeSignature/CodeResources'), 'original native signature'],
    [paths.productJson, '{"commit":"vendor-build-a"}'], [join(appRoot, 'package.json'), '{"version":"3.26.13"}'],
    [paths.workbenchJs, 'original renderer'], [join(paths.cursor2plusDir, 'package.json'), '{"version":"0.1.0"}'],
    [join(configDir, 'providers.json'), '{"provider":"synthetic NAS","thinkingLevel":"max"}\r\n'],
    [join(configDir, 'routes.json'), '{"server":{"host":"127.0.0.1","port":39831}}\r\n'],
  ]) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, body, { mode: 0o600 }); }
  return { root, bundle, paths, configDir };
}
function prepare(paths, configDir) {
  writeFileSync(paths.workbenchJs, 'prepared renderer');
  writeFileSync(join(configDir, 'models-catalog.json'), 'new catalogue', { mode: 0o600 });
  writeInstallationManifest(paths, [paths.workbenchJs, paths.productJson, join(paths.cursor2plusDir, 'package.json')]);
}

test('macOS swap preserves NAS/Max bytes, keeps a complete original, and signs only outside-journal preparation', async t => {
  const f = fixture(t), native = fakeNative();
  const before = bundleDigest(f.bundle), config = bundleDigest(f.configDir);
  const bytes = ['providers.json', 'routes.json'].map(n => readFileSync(join(f.configDir, n)));
  const logs = [];
  await withMacOSBundleTransaction(f.paths, prepare, { configDir: f.configDir, run: native.run, log: s => logs.push(s) });
  assert.equal(readFileSync(f.paths.workbenchJs, 'utf8'), 'prepared renderer');
  ['providers.json', 'routes.json'].forEach((n, i) => assert.deepEqual(readFileSync(join(f.configDir, n)), bytes[i]));
  assert.equal(existsSync(macOSJournal(f.bundle)), false);
  assert.equal(existsSync(join(f.paths.appRoot, '.ccursor-transaction.json')), false);
  const backup = logs.find(s => s.includes('retained at ')).split('retained at ')[1];
  assert.equal(bundleDigest(join(backup, 'original.app')), before);
  ['providers.json', 'routes.json'].forEach((n, i) => assert.deepEqual(readFileSync(join(backup, 'original-config', n)), bytes[i]));
  assert.doesNotThrow(() => validateInstallation(f.paths));
  assert.equal(compatibilityState(f.paths, { configDir: f.configDir }).state, 'installed');
  const sign = native.calls.find(c => c.args[0] === '--force');
  assert.ok(sign.args.includes('runtime'));
  assert.equal(sign.args.includes('--deep'), false, 'vendor frameworks are never re-signed');
  assert.ok(native.calls.every(c => !c.cmd.endsWith('xattr') && !c.cmd.endsWith('spctl')));
});

for (const failAt of ['before-app-move', 'after-app-move', 'after-app-replace', 'config:models-catalog.json', 'after-config', 'verified']) {
  test(`macOS failure at ${failAt} restores original native signature and every configuration byte`, async t => {
    const f = fixture(t), before = bundleDigest(f.bundle), config = bundleDigest(f.configDir);
    await assert.rejects(withMacOSBundleTransaction(f.paths, prepare, { configDir: f.configDir, run: fakeNative().run,
      beforeCommit(phase) { if (phase === failAt) throw Error('injected commit failure'); } }), /injected commit failure/);
    assert.equal(bundleDigest(f.bundle), before);
    assert.equal(bundleDigest(f.configDir), config);
    assert.equal(existsSync(macOSJournal(f.bundle)), false);
  });
}

test('signing, entitlement and post-signature verification failures do not alter the live application', async t => {
  for (const options of [{ failSign: true }, { entitlements: {} }, { failFinal: true }]) {
    const f = fixture(t), before = bundleDigest(f.bundle), config = bundleDigest(f.configDir);
    await assert.rejects(withMacOSBundleTransaction(f.paths, prepare, { configDir: f.configDir, run: fakeNative(options).run }));
    assert.equal(bundleDigest(f.bundle), before);
    assert.equal(bundleDigest(f.configDir), config);
  }
});

test('running Cursor and a version change during detection are refused before mutation', async t => {
  const f = fixture(t), before = bundleDigest(f.bundle);
  await assert.rejects(withMacOSBundleTransaction(f.paths, prepare, { configDir: f.configDir, run: fakeNative({ running: `${join(f.bundle, 'Contents/MacOS/Cursor')}\n` }).run }), /Close all Cursor/);
  await assert.rejects(withMacOSBundleTransaction({ ...f.paths, cursorVersion: '3.25.9' }, prepare, { configDir: f.configDir, run: fakeNative().run }), /updated during detection/);
  assert.equal(bundleDigest(f.bundle), before);
});

test('official updates and configuration edits during preparation are retained, never overwritten', async t => {
  for (const change of ['application', 'config']) {
    const f = fixture(t), before = bundleDigest(f.bundle);
    await assert.rejects(withMacOSBundleTransaction(f.paths, prepare, { configDir: f.configDir, run: fakeNative().run, afterPrepare() {
      writeFileSync(change === 'application' ? f.paths.workbenchJs : join(f.configDir, 'providers.json'), 'concurrent edit');
    } }), /changed during preparation/);
    if (change === 'config') assert.equal(bundleDigest(f.bundle), before);
    assert.equal(readFileSync(change === 'application' ? f.paths.workbenchJs : join(f.configDir, 'providers.json'), 'utf8'), 'concurrent edit');
  }
});

test('a failed rollback preserves journal and refuses to overwrite a concurrent user edit', async t => {
  const f = fixture(t);
  await assert.rejects(withMacOSBundleTransaction(f.paths, prepare, { configDir: f.configDir, run: fakeNative().run, beforeCommit(phase) {
    if (phase === 'after-app-replace') { writeFileSync(f.paths.workbenchJs, 'concurrent edit'); throw Error('failure'); }
  } }), /recovery retained/);
  assert.equal(existsSync(macOSJournal(f.bundle)), true);
  assert.throws(() => recoverMacOSBundle(f.bundle, { configDir: f.configDir, run: fakeNative().run }), /Concurrent Cursor update/);
  assert.equal(readFileSync(f.paths.workbenchJs, 'utf8'), 'concurrent edit');
});

for (const phase of ['after-app-move', 'after-app-replace', 'after-config']) test(`killed process at ${phase} is recoverable through the platform recovery entrypoint`, t => {
  const f = fixture(t), before = bundleDigest(f.bundle), config = bundleDigest(f.configDir);
  const script = `import {withMacOSBundleTransaction} from ${JSON.stringify(new URL('../src/macos-transaction.js', import.meta.url).href)};
    import {cpSync,writeFileSync} from 'node:fs';import {join} from 'node:path';
    const run=(cmd,args,o={})=>{if(cmd.endsWith('/ps'))return '';if(cmd.endsWith('/ditto')){cpSync(args.at(-2),args.at(-1),{recursive:true});return '';}if(cmd.endsWith('/plutil'))return !o.input?JSON.stringify({CFBundleExecutable:'Cursor',CFBundleIdentifier:'com.todesktop.230313mzl4w4u92',CFBundleShortVersionString:'3.26.13'}):args[1]==='json'?o.input.slice(6,-8):'<?xml>'+o.input+'</plist>';if(args.includes('--entitlements'))return '<?xml>'+JSON.stringify({'com.apple.security.cs.allow-jit':true,'com.apple.security.cs.disable-library-validation':true})+'</plist>';return 'Signature=adhoc\\nflags=0x10002(adhoc,runtime)';};
    await withMacOSBundleTransaction(${JSON.stringify(f.paths)},async(p,c)=>{writeFileSync(p.workbenchJs,'new');writeFileSync(join(c,'providers.json'),'temporary configuration');},{configDir:${JSON.stringify(f.configDir)},run,beforeCommit(phase){if(phase===${JSON.stringify(phase)})process.exit(23);}});`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(r.status, 23, r.stderr);
  assert.equal(existsSync(f.bundle), phase !== 'after-app-move');
  if (process.platform === 'darwin') {
    const previous = process.env.CCURSOR_CURSOR_ROOT;
    process.env.CCURSOR_CURSOR_ROOT = f.paths.appRoot;
    try { assert.equal(recoverPlatformInstallation(null, { configDir: f.configDir }), true); }
    finally { if (previous === undefined) delete process.env.CCURSOR_CURSOR_ROOT; else process.env.CCURSOR_CURSOR_ROOT = previous; }
  } else assert.equal(recoverMacOSBundle(f.bundle, { configDir: f.configDir, run: fakeNative().run }), true);
  assert.equal(bundleDigest(f.bundle), before);
  assert.equal(bundleDigest(f.configDir), config);
});

test('permission normalization commits the prepared mode and rollback restores the original mode', { skip: process.platform === 'win32' }, async t => {
  for (const fail of [false, true]) {
    const f = fixture(t), file = join(f.configDir, 'providers.json');
    chmodSync(file, 0o640);
    const options = { configDir: f.configDir, run: fakeNative().run,
      beforeCommit(phase) { if (fail && phase === 'after-config') throw Error('rollback modes'); } };
    const change = (p, c) => { prepare(p, c); chmodSync(join(c, 'providers.json'), 0o600); };
    if (fail) await assert.rejects(withMacOSBundleTransaction(f.paths, change, options), /rollback modes/);
    else await withMacOSBundleTransaction(f.paths, change, options);
    assert.equal(statSync(file).mode & 0o777, fail ? 0o640 : 0o600);
  }
});

test('extra native runtime protection flags fail closed rather than being silently removed', t => {
  const f = fixture(t), before = bundleDigest(f.bundle), n = fakeNative();
  const run = (cmd, args, options) => cmd.endsWith('/codesign') && args[0] === '-dv'
    ? 'Signature=adhoc\nflags=0x10802(adhoc,restrict,runtime)' : n.run(cmd, args, options);
  assert.throws(() => signMacOSBundle(f.bundle, f.root, { run }), /refusing to remove existing runtime protections/);
  assert.equal(bundleDigest(f.bundle), before);
});

test('mismatched native/resource versions and failed staged patch validation cannot reach commit', async t => {
  for (const kind of ['version', 'validation']) {
    const f = fixture(t), before = bundleDigest(f.bundle), native = fakeNative();
    const run = (command, args, options) => command.endsWith('/plutil') && !options?.input && kind === 'version'
      ? JSON.stringify({ CFBundleExecutable: 'Cursor', CFBundleIdentifier: 'com.todesktop.230313mzl4w4u92', CFBundleShortVersionString: '9.9.9' })
      : native.run(command, args, options);
    await assert.rejects(withMacOSBundleTransaction(f.paths, prepare, { configDir: f.configDir, run,
      validatePrepared() { if (kind === 'validation') throw Error('partial patches'); } }), /differs from resources|partial patches/);
    assert.equal(bundleDigest(f.bundle), before);
  }
});

test('update receipt survives a vendor replacement and reports build changes, not only version changes', t => {
  const f = fixture(t);
  writeFileSync(join(f.configDir, INSTALLATION_RECEIPT), JSON.stringify({ installed: true, cursorVersion: '3.26.13', cursorCommit: 'previous-build' }));
  assert.equal(compatibilityState(f.paths, { configDir: f.configDir }).state, 'cursor-updated');
  writeInstallationManifest(f.paths, [f.paths.workbenchJs]);
  writeFileSync(f.paths.workbenchJs, 'partial official update');
  assert.equal(compatibilityState(f.paths, { configDir: f.configDir }).state, 'modified-or-mixed-build');
});

test('unknown entitlement metadata and nested symlinked target paths are rejected', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t);
  const target = join(f.configDir, 'providers.json');
  rmSync(target); symlinkSync(join(f.root, 'missing-secret'), target);
  await assert.rejects(withMacOSBundleTransaction(f.paths, prepare, { configDir: f.configDir, run: fakeNative().run }), /symlinked/);
});

test('native signing report and running-process parsing are bounded to the specified application', t => {
  const f = fixture(t);
  assert.equal(macOSBundle(f.paths, 'linux'), null);
  assert.equal(macOSBundle(f.paths, 'darwin'), f.bundle);
  assert.doesNotThrow(() => assertCursorClosed(f.bundle, () => '/different/Cursor.app/Contents/MacOS/Cursor\n'));
  assert.equal(inspectMacOSSignature(f.bundle, { run: () => { throw Error('private secret'); } }).kind, 'unknown');
  const n = fakeNative();
  signMacOSBundle(f.bundle, f.root, { run: n.run });
  assert.equal(inspectMacOSSignature(f.bundle, { run: n.run }).libraryValidationException, true);
});
