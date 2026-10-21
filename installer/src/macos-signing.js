/** Local development signing. Never changes Gatekeeper, SIP or vendor frameworks. */
import { spawnSync } from 'child_process';
import { existsSync, lstatSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';

export function macOSBundle(paths, platform = process.platform) {
  if (platform !== 'darwin') return null;
  const root = resolve(paths.appRoot);
  const bundle = dirname(dirname(dirname(root)));
  if (!bundle.endsWith('.app') || join(bundle, 'Contents', 'Resources', 'app') !== root) return null;
  return bundle;
}

export function nativeCommand(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024, ...options });
  if (result.error || result.status !== 0) throw new Error(`macOS ${command.split('/').pop()} failed; original application will be preserved (${result.error?.code || result.status})`);
  return `${result.stdout || ''}${result.stderr || ''}`;
}

export function assertBundleLayout(bundle) {
  for (const path of [bundle, join(bundle, 'Contents'), join(bundle, 'Contents/Resources'), join(bundle, 'Contents/Resources/app'), join(bundle, 'Contents/MacOS'), join(bundle, 'Contents/MacOS/Cursor')]) {
    if (!existsSync(path) || lstatSync(path).isSymbolicLink()) throw new Error('Unsupported or symlinked macOS Cursor application layout');
  }
  if (!existsSync(join(bundle, 'Contents/Info.plist'))) throw new Error('macOS Cursor Info.plist missing');
}

export function assertCursorClosed(bundle, run = nativeCommand) {
  const processes = run('/bin/ps', ['-axo', 'comm=']);
  if (processes.split('\n').some(line => line.trim() === join(bundle, 'Contents/MacOS/Cursor')))
    throw new Error('Close all Cursor windows and quit Cursor before installing or recovering.');
}

export function assertNativeCompatibility(bundle, cursorVersion, run = nativeCommand) {
  const info = JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(bundle, 'Contents/Info.plist')]));
  if (info.CFBundleExecutable !== 'Cursor' || info.CFBundleIdentifier !== 'com.todesktop.230313mzl4w4u92'
      || info.CFBundleShortVersionString !== cursorVersion)
    throw new Error('Native Cursor bundle identity/version differs from resources; wait for the official update to finish or restore a complete application.');
}

function readEntitlements(bundle, run) {
  const output = run('/usr/bin/codesign', ['-d', '--entitlements', ':-', bundle]);
  const start = output.indexOf('<?xml'), end = output.indexOf('</plist>', start);
  if (start < 0 || end < 0) throw new Error('Cannot read original macOS entitlements; refusing to invent signing permissions');
  const xml = output.slice(start, end + 8);
  return JSON.parse(run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '--', '-'], { input: xml }));
}

export function inspectMacOSSignature(bundle, { run = nativeCommand } = {}) {
  let details, entitlements;
  try {
    details = run('/usr/bin/codesign', ['-dv', '--verbose=4', bundle]);
    entitlements = readEntitlements(bundle, run);
  } catch { return { applicable: true, valid: false, kind: 'unknown', hardenedRuntime: false, libraryValidationException: false }; }
  let valid = false;
  try { run('/usr/bin/codesign', ['--verify', '--deep', '--strict', bundle]); valid = true; } catch {}
  return { applicable: true, valid, kind: /Signature=adhoc/.test(details) ? 'local-ad-hoc' : 'certificate',
    hardenedRuntime: /flags=0x[0-9a-f]+\([^)]*\bruntime\b/.test(details),
    libraryValidationException: entitlements['com.apple.security.cs.disable-library-validation'] === true };
}

export function signatureHealthy(signature) {
  return signature.valid && signature.hardenedRuntime && (signature.kind === 'certificate' || signature.libraryValidationException);
}

export function signMacOSBundle(bundle, workspace, { run = nativeCommand, log = () => {} } = {}) {
  assertBundleLayout(bundle);
  const original = readEntitlements(bundle, run);
  const details = run('/usr/bin/codesign', ['-dv', '--verbose=4', bundle]);
  const flags = details.match(/flags=0x[0-9a-f]+\(([^)]*)\)/)?.[1]?.split(',') || [];
  if (!flags.includes('runtime') || flags.some(flag => !['adhoc', 'runtime'].includes(flag)))
    throw new Error('Unrecognized native signing flags; refusing to remove existing runtime protections');
  // The accepted Cursor/Electron host uses JIT. Unknown native layouts fail closed.
  if (original['com.apple.security.cs.allow-jit'] !== true)
    throw new Error('Unrecognized Cursor/Electron entitlements; macOS signing requires compatibility review');
  const expected = { ...original, 'com.apple.security.cs.disable-library-validation': true };
  const file = join(workspace, 'local-entitlements.plist');
  const xml = run('/usr/bin/plutil', ['-convert', 'xml1', '-o', '-', '--', '-'], { input: JSON.stringify(expected) });
  writeFileSync(file, xml, { mode: 0o600 });
  log('macOS: local ad-hoc signing; hardened runtime retained; app-scoped library validation exception. Gatekeeper unchanged.');
  // Sign only the outer application. Keep original nested framework identities.
  run('/usr/bin/codesign', ['--force', '--sign', '-', '--options', 'runtime', '--entitlements', file, bundle]);
  const actual = readEntitlements(bundle, run);
  const canonical = value => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : value;
  const ordered = value => JSON.stringify(canonical(value));
  if (ordered(actual) !== ordered(expected)) throw new Error('macOS signing changed unexpected entitlements');
  const signature = inspectMacOSSignature(bundle, { run });
  if (!signatureHealthy(signature) || signature.kind !== 'local-ad-hoc') throw new Error('macOS signature verification failed');
  return signature;
}

export function copyMacOSBundle(source, target, run = nativeCommand) {
  // A newly prepared local artifact must not inherit stale download provenance.
  run('/usr/bin/ditto', ['--noextattr', '--noqtn', '--acl', source, target]);
}
