import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const installerRoot = fileURLToPath(new URL('../', import.meta.url));
const fixtureRoot = mkdtempSync(join(tmpdir(), 'ccursor-check-targets-'));
after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
const checkBundle = join(fixtureRoot, 'check.cjs');
const mockChecks = new Map(Object.entries({
  'patch-always-local.js': 'export function checkAlwaysLocalPatch(){return true;}',
  'patch-agent-host.js': 'export function checkAgentHostPatch(){return true;}',
  'patch-proxy-39.js': 'export function needsProxy39Patch(){return false;} export function checkProxy39Patch(){return true;}',
  'patch-agent-host-gate.js': 'export function checkAgentHostGatePatch(){return true;}',
  'patch-runtime-compat.js': 'export function checkRuntimeCompat(){return true;}',
}).map(([name, source]) => [join(installerRoot, 'src', name), source]));

// Leave the real detector and renderer AST matcher active. Other compatibility
// checks are held valid so each targeted failure must determine the exit code.
await build({
  stdin: {
    contents: `import {check} from ${JSON.stringify(join(installerRoot, 'src/check.js'))};check().catch(error=>{console.error(error.message);process.exitCode=1;});`,
    resolveDir: installerRoot,
  },
  outfile: checkBundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  logLevel: 'silent',
  plugins: [{
    name: 'other-checks-already-valid',
    setup(builder) {
      builder.onResolve({ filter: /^\.\// }, args => {
        const path = resolve(dirname(args.importer), args.path);
        return mockChecks.has(path) ? { path, namespace: 'check-fixture' } : undefined;
      });
      builder.onLoad({ filter: /.*/, namespace: 'check-fixture' }, args => ({ contents: mockChecks.get(args.path), loader: 'js' }));
    },
  }],
});

const renderer = `
"callback-client.js";
function dispatch(service,transport){
  switch(service.kind){
    case Method.Unary:return transport.unary;
    case Method.ServerStreaming:return transport.stream;
    case Method.BiDiStreaming:return transport.stream;
  }
}
function createClient(service,transport){return dispatch(service,transport)}
`;

function runFixture(name, { source = renderer, extensionHost = true } = {}) {
  const appRoot = join(fixtureRoot, name);
  const originals = new Map([
    ['package.json', '{"version":"3.25.9"}'],
    ['product.json', '{}'],
    ['out/vs/workbench/workbench.desktop.main.js', source],
    ['extensions/cursor-always-local/dist/main.js', '/* other checks are stubbed valid */'],
  ]);
  if (extensionHost)
    originals.set('out/vs/workbench/api/node/extensionHostProcess.js', 'if(!e.valid){throw Error("signature");}');
  for (const [relativePath, content] of originals) {
    const file = join(appRoot, relativePath);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }

  const result = spawnSync(process.execPath, [checkBundle], {
    encoding: 'utf8',
    env: { ...process.env, CCURSOR_CURSOR_ROOT: appRoot },
    timeout: 10000,
  });
  assert.ifError(result.error);
  for (const [relativePath, content] of originals)
    assert.equal(readFileSync(join(appRoot, relativePath), 'utf8'), content);
  return result;
}

test('renderer preflight accepts a semantic dispatcher and delegate wrapper', () => {
  const result = runFixture('matchable');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Renderer hook target \(desktop\): function createClient/);
  assert.match(result.stdout, /All patch targets matchable/);
});

test('renderer preflight rejects a literal module anchor without the semantic dispatcher', () => {
  const result = runFixture('anchor-only', { source: 'console.log("callback-client.js");' });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Renderer hook target \(desktop\) not matchable: Dispatcher function not found/);
  assert.match(result.stderr, /Some patch targets are not matchable/);
});

test('preflight rejects a missing extension host even when the renderer target matches', () => {
  const result = runFixture('missing-extension-host', { extensionHost: false });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Renderer hook target \(desktop\): function createClient/);
  assert.match(result.stdout, /extensionHostProcess\.js not found \(required for signature patch\)/);
});

test('renderer preflight retains partial hook rejection before AST matching', () => {
  const result = runFixture('partial-hook', { source: `/* CURSOR-BYOK-HOOK-START */${renderer}` });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Renderer hook \(desktop\) is partial/);
  assert.doesNotMatch(result.stdout, /Renderer hook target \(desktop\): function createClient/);
});
