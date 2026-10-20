import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createBackup, restoreBackup } from '../src/backup.js';
import { treeFiles, withInstallationTransaction, recoverInstallation, JOURNAL_FILE } from '../src/transaction.js';
import { digest, writeInstallationManifest, validateInstallation } from '../src/installation-state.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'ccursor-txn-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const appRoot = join(root, 'app'), configDir = join(root, 'config');
  const paths = { appRoot, cursorVersion: '3.25.9', hasGlass: true,
    productJson: join(appRoot, 'product.json'), workbenchJs: join(appRoot, 'out/workbench.js'),
    glassJs: join(appRoot, 'out/glass.js'), extensionHostJs: join(appRoot, 'out/extensionHost.js'),
    alwaysLocalMain: join(appRoot, 'extensions/cursor-always-local/dist/main.js'),
    agentHostDist: join(appRoot, 'extensions/cursor-agent-host/dist'), agentHostMain: join(appRoot, 'extensions/cursor-agent-host/dist/main.js'),
    cursor2plusDir: join(appRoot, 'extensions/cursor2plus') };
  const files = [
    [paths.productJson, '{"commit":"vendor-build-a","checksums":{}}'], [join(appRoot, 'package.json'), '{"version":"3.25.9"}'],
    [paths.workbenchJs, 'original renderer'], [paths.glassJs, 'original glass'],
    [join(paths.cursor2plusDir, 'package.json'), '{"name":"cursor2plus"}'], [join(paths.cursor2plusDir, 'old.js'), 'working extension'],
    [join(configDir, 'routes.json'), '{"byokMode":1,"server":{"host":"127.0.0.7","port":41000}}\r\n'],
    [join(configDir, 'providers.json'), '{"providers":[{"id":"NAS","thinkingLevel":"max","key":"synthetic-only"}]}\r\n'],
  ];
  for (const [file, data] of files) { mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, data, { mode: 0o600 }); }
  return { root, paths, configDir };
}

function snapshot(root) {
  return Object.fromEntries(treeFiles(root).map(file => [file.slice(root.length), [readFileSync(file).toString('base64'), statSync(file).mode & 0o777]]));
}

const mutations = [
  paths => createBackup(paths.workbenchJs, 'inject'),
  paths => writeFileSync(paths.workbenchJs, 'new renderer'),
  paths => writeFileSync(paths.glassJs, 'new glass'),
  paths => { rmSync(paths.cursor2plusDir, { recursive: true }); mkdirSync(paths.cursor2plusDir); writeFileSync(join(paths.cursor2plusDir, 'new.js'), 'new extension'); },
  (paths, configDir) => writeFileSync(join(configDir, 'web-tools.json'), '{"fixture":true}', { mode: 0o600 }),
  paths => writeInstallationManifest(paths, [paths.workbenchJs, paths.glassJs, ...treeFiles(paths.cursor2plusDir)]),
];
async function prepare(paths, configDir) { for (const mutation of mutations) mutation(paths, configDir); }

for (let failure = 0; failure < mutations.length; failure++) {
  test(`preparation failure after step ${failure} never mutates application or NAS/Max configuration`, async t => {
    const { root, paths, configDir } = fixture(t), before = snapshot(root);
    await assert.rejects(withInstallationTransaction(paths, async (staged, config) => {
      for (const [index, mutation] of mutations.entries()) { mutation(staged, config); if (index === failure) throw Error('injected prepare failure'); }
    }, { configDir }), /injected prepare failure/);
    assert.deepEqual(snapshot(root), before);
  });
}

test('successful commit replaces all prepared components and retains private configuration bytes', async t => {
  const { root, paths, configDir } = fixture(t);
  const providers = readFileSync(join(configDir, 'providers.json'));
  const routes = readFileSync(join(configDir, 'routes.json'));
  const count = await withInstallationTransaction(paths, prepare, { configDir });
  assert.equal(count, 7);
  assert.equal(readFileSync(paths.workbenchJs, 'utf8'), 'new renderer');
  assert.equal(existsSync(join(paths.cursor2plusDir, 'old.js')), false);
  assert.deepEqual(readFileSync(join(configDir, 'providers.json')), providers);
  assert.deepEqual(readFileSync(join(configDir, 'routes.json')), routes);
  assert.equal(existsSync(join(paths.appRoot, JOURNAL_FILE)), false);
  assert.doesNotThrow(() => validateInstallation(paths));
});

for (let failure = 0; failure < 7; failure++) {
  test(`commit failure at operation ${failure} restores all prior bytes and modes`, async t => {
    const { root, paths, configDir } = fixture(t), before = snapshot(root);
    await assert.rejects(withInstallationTransaction(paths, prepare, { configDir, beforeCommit(index) {
      if (index === failure) throw Error('injected commit failure');
    } }), /injected commit failure/);
    assert.deepEqual(snapshot(root), before);
  });
}

test('concurrent edit during preparation is retained and prevents committing a stale plan', async t => {
  const { paths, configDir } = fixture(t);
  await assert.rejects(withInstallationTransaction(paths, async (staged, config) => {
    await prepare(staged, config);
    writeFileSync(paths.workbenchJs, 'concurrent user edit');
  }, { configDir }), /changed during preparation/);
  assert.equal(readFileSync(paths.workbenchJs, 'utf8'), 'concurrent user edit');
  assert.equal(readFileSync(paths.glassJs, 'utf8'), 'original glass');
});

test('concurrent edit before a later commit operation is not overwritten by rollback', async t => {
  const { paths, configDir } = fixture(t);
  let changed;
  await assert.rejects(withInstallationTransaction(paths, prepare, { configDir, beforeCommit(index, target) {
    if (index === 1) { changed = target; writeFileSync(target, 'concurrent user edit'); }
  } }), /changed during commit/);
  assert.equal(readFileSync(changed, 'utf8'), 'concurrent user edit');
  assert.equal(existsSync(join(paths.appRoot, JOURNAL_FILE)), false);
});

test('backup checksum and Cursor version guards refuse destructive restores', t => {
  const { paths } = fixture(t);
  const backup = createBackup(paths.workbenchJs, 'inject');
  writeFileSync(paths.workbenchJs, 'working patched version');
  writeFileSync(join(paths.appRoot, 'package.json'), '{"version":"3.26.0"}');
  assert.throws(() => restoreBackup(paths.workbenchJs, 'inject'), /differs from the backup/);
  assert.equal(readFileSync(paths.workbenchJs, 'utf8'), 'working patched version');
  writeFileSync(join(paths.appRoot, 'package.json'), '{"version":"3.25.9"}');
  writeFileSync(backup, 'corrupt backup');
  assert.throws(() => restoreBackup(paths.workbenchJs, 'inject'), /checksum mismatch/);
  assert.equal(readFileSync(paths.workbenchJs, 'utf8'), 'working patched version');
});

test('legacy backup adoption requires matching vendor product builds', t => {
  const { paths } = fixture(t);
  const backup = `${paths.workbenchJs}.backup-byok-inject-old`;
  writeFileSync(backup, 'old renderer');
  assert.throws(() => createBackup(paths.workbenchJs, 'inject'), /legacy backups cannot be verified/);
  writeFileSync(`${paths.productJson}.backup-byok-inject-old`, '{"commit":"another-build"}');
  assert.throws(() => createBackup(paths.workbenchJs, 'inject'), /legacy backups cannot be verified/);
  writeFileSync(`${paths.productJson}.backup-byok-inject-old`, '{"commit":"vendor-build-a"}');
  assert.equal(createBackup(paths.workbenchJs, 'inject'), backup);
  assert.equal(JSON.parse(readFileSync(`${backup}.metadata.json`)).originalHash, digest(Buffer.from('old renderer')));
});

test('process interruption leaves a journal that can restore the previous installation', t => {
  const { root, paths, configDir } = fixture(t), before = snapshot(root);
  const script = `import {withInstallationTransaction} from ${JSON.stringify(new URL('../src/transaction.js', import.meta.url).href)};
    import {writeFileSync} from 'node:fs';
    await withInstallationTransaction(${JSON.stringify(paths)}, async staged => {
      writeFileSync(staged.workbenchJs,'interrupted renderer');writeFileSync(staged.glassJs,'interrupted glass');
    },{configDir:${JSON.stringify(configDir)},beforeCommit(index){if(index===1)process.exit(66);}});`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 66, child.stderr);
  assert.equal(existsSync(join(paths.appRoot, JOURNAL_FILE)), true);
  recoverInstallation(paths, { configDir });
  assert.deepEqual(snapshot(root), before);
});
