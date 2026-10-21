import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const installerRoot = fileURLToPath(new URL('../', import.meta.url));
const fixtureRoot = mkdtempSync(join(tmpdir(), 'ccursor-install-flow-'));
after(() => {
  delete globalThis.__ccursorInstallFixture;
  rmSync(fixtureRoot, { recursive: true, force: true });
});

async function buildFixture(entry, outfile, modules) {
  const mocks = new Map(Object.entries(modules).map(([name, source]) => [join(installerRoot, 'src', name), source]));
  await build({
    entryPoints: [join(installerRoot, 'src', entry)],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    logLevel: 'silent',
    plugins: [{
      name: 'isolated-installer-dependencies',
      setup(builder) {
        builder.onResolve({ filter: /^\.\// }, args => {
          const path = resolve(dirname(args.importer), args.path);
          return mocks.has(path) ? { path, namespace: 'installer-fixture' } : undefined;
        });
        builder.onLoad({ filter: /.*/, namespace: 'installer-fixture' }, args => ({ contents: mocks.get(args.path), loader: 'js' }));
      },
    }],
  });
}

const common = `
import { writeFileSync } from 'node:fs';
const state = () => globalThis.__ccursorInstallFixture;
function mutation(name) {
  state().events.push(name);
  writeFileSync(state().mutationFile, state().events.join('\\n'));
}
`;
const installBundle = join(fixtureRoot, 'install.cjs');
await buildFixture('install.js', installBundle, {
  'transaction.js': `${common} export function applicationFiles(){return [];} export function treeFiles(){return [];}`,
  'platform-transaction.js': `${common} export function assertPlatformReady(){if(state().running)throw Error('Close all Cursor windows');} export function platformSignatureNeedsRepair(){return state().badSignature;} export async function withPlatformTransaction(paths,prepare){state().transactions=(state().transactions||0)+1;return prepare(paths,state().configDir);}`,
  'verify.js': `export function verifyPreparedInstallation(){}`,
  'installation-state.js': `${common} export function validateInstallation(){} export function writeInstallationManifest(){}`,
  'detect.js': `${common} export function findCursorPathsDetailed(){ return {paths:state().paths,diagnostic:{}}; } export function formatDiagnostic(){return 'fixture';}`,
  'check.js': `${common} export async function check(){state().events.push('check:start');await new Promise(resolve=>setImmediate(resolve));if(state().failPreflight)throw Error('fixture preflight failed');state().events.push('check:complete');}`,
  'extension-embed.js': `${common} export function isExtensionInstalled(){return state().installed;} export function installExtension(){mutation('extension');}`,
  'backup.js': `${common} export function hasBackup(){return state().backups;}`,
  'patch-inject.js': `${common} export function isInjectPatched(){return state().fullyPatched;} export function patchInject(){mutation('inject');}`,
  'patch-always-local.js': `${common} export function inspectAlwaysLocalPatch(){return {fullyPatched:state().fullyPatched};} export function patchAlwaysLocal(){mutation('always-local');}`,
  'patch-agent-host.js': `${common} export function getAgentHostBackupTargets(){return [];} export function isAgentHostPatched(){return state().fullyPatched;} export function patchAgentHost(){mutation('agent-host');}`,
  'patch-proxy-39.js': `${common} export function needsProxy39Patch(){return true;} export function isProxy39Patched(){return state().fullyPatched;} export function patchProxy39(){mutation('proxy-39');}`,
  'patch-katex.js': `${common} export function patchKatex(){mutation('katex');}`,
  'patch-agent-host-gate.js': `${common} export function isAgentHostGateFullyPatched(){return state().fullyPatched;} export function patchAgentHostGate(){mutation('agent-host-gate');}`,
  'patch-runtime-compat.js': `${common} export function isRuntimeCompatPatched(){return state().fullyPatched;} export function patchRuntimeCompat(){mutation('runtime-compat');}`,
  'release-defaults.js': `${common} export function releaseDefaults(){mutation('defaults');}`,
});
const { install } = createRequire(import.meta.url)(installBundle);

function startFixture(name, overrides = {}) {
  const root = join(fixtureRoot, name);
  mkdirSync(root);
  const workbenchJs = join(root, 'workbench.js');
  writeFileSync(workbenchJs, 'fixture original renderer');
  const state = {
    events: [],
    paths: { appRoot: root, cursorVersion: '3.25.9', workbenchJs, glassJs: join(root, 'absent-glass.js') },
    mutationFile: join(root, 'mutation-receipt'),
    configDir: join(root, 'config'),
    installed: true,
    fullyPatched: false,
    backups: false,
    failPreflight: false,
    ...overrides,
  };
  globalThis.__ccursorInstallFixture = state;
  return state;
}

test('install awaits full preflight failure before writing configuration, extension or patches', async () => {
  const state = startFixture('failed-preflight', { failPreflight: true });
  await assert.rejects(install(), /fixture preflight failed/);
  assert.deepEqual(state.events, ['check:start']);
  assert.equal(existsSync(state.mutationFile), false);
  assert.equal(readFileSync(state.paths.workbenchJs, 'utf8'), 'fixture original renderer');
});

test('successful install verifies all targets before starting any mutation', async () => {
  const state = startFixture('successful-install');
  await install();
  assert.deepEqual(state.events, [
    'check:start', 'check:complete', 'defaults', 'extension', 'inject',
    'always-local', 'agent-host', 'proxy-39', 'katex', 'agent-host-gate', 'runtime-compat',
  ]);
});

test('fully patched install is a no-op unless an extension refresh is requested', async () => {
  const state = startFixture('already-installed', { fullyPatched: true });
  await install();
  assert.deepEqual(state.events, ['check:start', 'check:complete']);
  assert.equal(existsSync(state.mutationFile), false);

  state.events.length = 0;
  await install({ refreshExtension: true });
  assert.deepEqual(state.events, ['check:start', 'check:complete', 'extension']);
});

test('existing backups without the extension reject installation before any write', async () => {
  const state = startFixture('missing-extension', { installed: false, backups: true });
  await assert.rejects(install(), /Existing backups require recovery/);
  assert.deepEqual(state.events, ['check:start', 'check:complete']);
  assert.equal(existsSync(state.mutationFile), false);
});

test('running Cursor is rejected before compatibility checks or any mutation', async () => {
  const state = startFixture('running-cursor', { running: true });
  await assert.rejects(install({ refreshExtension: true }), /Close all Cursor/);
  assert.deepEqual(state.events, []);
  assert.equal(existsSync(state.mutationFile), false);
});

test('fully patched application with an invalid native signature still enters the repair transaction', async () => {
  const state = startFixture('invalid-signature', { fullyPatched: true, badSignature: true });
  await install();
  assert.equal(state.transactions, 1);
  assert.deepEqual(state.events, ['check:start', 'check:complete']);
});

const cliBundle = join(fixtureRoot, 'cli.cjs');
await buildFixture('cli.js', cliBundle, {
  'install.js': `export async function install(options){console.log('INSTALL_OPTIONS='+JSON.stringify(options));}`,
  'uninstall.js': `export async function uninstall(){throw Error('update must not uninstall first');}`,
});
for (const command of ['update', 'upgrade', 'repair']) {
  test(`${command} refreshes the extension without uninstalling`, () => {
    const result = spawnSync(process.execPath, [cliBundle, command], { encoding: 'utf8', timeout: 10000 });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /INSTALL_OPTIONS=\{"refreshExtension":true\}/);
    assert.equal(result.stderr, '');
  });
}
