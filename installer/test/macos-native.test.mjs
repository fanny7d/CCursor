/** Real codesign/plutil/dyld coverage on both Intel CI and local Apple Silicon. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { nativeCommand, inspectMacOSSignature } from '../src/macos-signing.js';
import { withMacOSBundleTransaction, bundleDigest } from '../src/macos-transaction.js';
import { writeInstallationManifest, INSTALLATION_MANIFEST } from '../src/installation-state.js';
import { compatibilityState } from '../src/compatibility-state.js';

test('real macOS bundle remains launchable after update, uninstall and reinstallation with unchanged nested signatures', { skip: process.platform !== 'darwin', timeout: 120000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'ccursor-native-signing-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bundle = join(root, 'Cursor local fixture.app'), appRoot = join(bundle, 'Contents/Resources/app'), configDir = join(root, 'config');
  const paths = { appRoot, cursorVersion: '3.26.13', productJson: join(appRoot, 'product.json'), workbenchJs: join(appRoot, 'workbench.js'), cursor2plusDir: join(appRoot, 'extension') };
  for (const p of [join(bundle, 'Contents/MacOS'), join(bundle, 'Contents/Frameworks'), appRoot, configDir]) mkdirSync(p, { recursive: true });
  const main = join(bundle, 'Contents/MacOS/Cursor'), library = join(bundle, 'Contents/Frameworks/libfixture.dylib');
  writeFileSync(join(root, 'main.c'), '#include <dlfcn.h>\n#include <stdio.h>\nint main(int argc,char **argv){if(argc!=2)return 2;void *h=dlopen(argv[1],RTLD_NOW);if(!h){fprintf(stderr,"%s",dlerror());return 3;}int(*v)(void)=dlsym(h,"fixture_value");if(!v||v()!=947)return 4;puts("MACOS_NATIVE_SIGNING_OK");return 0;}');
  writeFileSync(join(root, 'library.c'), 'int fixture_value(void){return 947;}');
  nativeCommand('/usr/bin/clang', [join(root, 'main.c'), '-o', main]);
  nativeCommand('/usr/bin/clang', ['-dynamiclib', join(root, 'library.c'), '-o', library]);
  nativeCommand('/bin/chmod', ['+a', 'everyone allow read', library]);
  const acl = () => nativeCommand('/bin/ls', ['-le', library]).split('\n').slice(1).join('\n');
  const originalACL = acl();
  assert.match(originalACL, /allow read/);
  const entitlements = join(root, 'entitlements.plist');
  writeFileSync(entitlements, '<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>com.apple.security.cs.allow-jit</key><true/><key>com.apple.security.device.camera</key><true/></dict></plist>');
  writeFileSync(join(bundle, 'Contents/Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.todesktop.230313mzl4w4u92</string><key>CFBundleShortVersionString</key><string>3.26.13</string><key>CFBundleExecutable</key><string>Cursor</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>');
  writeFileSync(paths.productJson, '{"commit":"real-native-fixture-vendor"}');
  writeFileSync(join(appRoot, 'package.json'), '{"version":"3.26.13"}');
  writeFileSync(paths.workbenchJs, 'original');
  const provider = '{"model":"gpt-6-luna","thinkingLevel":"max","apiKey":"synthetic-key"}\r\n';
  writeFileSync(join(configDir, 'providers.json'), provider, { mode: 0o600 });
  nativeCommand('/usr/bin/codesign', ['--force', '--sign', '-', library]);
  nativeCommand('/usr/bin/codesign', ['--force', '--sign', '-', '--options', 'runtime', '--entitlements', entitlements, bundle]);
  const libraryHash = bundleDigest(library);
  const prepare = p => { writeFileSync(p.workbenchJs, 'new'); writeInstallationManifest(p, [p.workbenchJs, p.productJson]); };
  for (const operation of ['update', 'uninstall', 'install']) {
    await withMacOSBundleTransaction(paths, p => {
      if (operation === 'uninstall') { writeFileSync(p.workbenchJs, 'original'); rmSync(join(p.appRoot, INSTALLATION_MANIFEST)); }
      else prepare(p);
    }, { configDir });
    const signature = inspectMacOSSignature(bundle);
    assert.equal(signature.valid, true);
    assert.equal(signature.hardenedRuntime, true);
    assert.equal(signature.libraryValidationException, true);
    assert.equal(bundleDigest(library), libraryHash, 'nested vendor library must retain its exact native signature');
    assert.equal(acl(), originalACL, 'existing ACLs must survive the complete application copy');
    const result = spawnSync(main, [library], { encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, `${result.stderr}\n${result.signal}`);
    assert.match(result.stdout, /MACOS_NATIVE_SIGNING_OK/);
    assert.equal(readFileSync(join(configDir, 'providers.json'), 'utf8'), provider);
  }
  // A same-version vendor replacement must still be recognized by its build ID.
  rmSync(join(appRoot, INSTALLATION_MANIFEST));
  writeFileSync(paths.productJson, '{"commit":"another-vendor-build"}');
  assert.equal(compatibilityState(paths, { configDir }).state, 'cursor-updated');
});
