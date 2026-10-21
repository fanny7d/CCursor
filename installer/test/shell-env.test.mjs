import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { patchShellEnvironmentSource, patchShellEnvironment, restoreShellEnvironment, SHELL_ENV_MARKER } from '../src/patch-shell-env.js';
import { shellEnvSource } from './fixtures/shell-env.mjs';

async function execute({ patched = true, block = false, hang = false, platform = 'darwin', exit = 0 } = {}) {
  const children = [], traces = [], cancelled = [];
  const timers = new Map();
  const schedule = (callback, delay) => {
    const handle = setTimeout(() => { timers.delete(handle); callback(); }, delay);
    timers.set(handle, callback);
    return handle;
  };
  const unschedule = handle => { timers.delete(handle); clearTimeout(handle); };
  class CancellationSource {
    constructor() { this.token = {}; }
    dispose(cancel) {
      if (cancel) { cancelled.push(true); for (const child of children) child.kill(); }
    }
  }
  const context = {
    process: { platform }, performance, setTimeout: schedule, clearTimeout: unschedule, CancellationSource,
    spawnShell: () => new Promise((resolve, reject) => {
      const code = hang ? 'setInterval(()=>{},1000)' : `process.stdout.write('resolved');process.exitCode=${exit}`;
      const child = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'pipe'] });
      children.push(child);
      child.stdout.resume(); child.stderr.resume();
      child.once('error', reject);
      child.once('close', code => code === 0 ? resolve({ TEST_PATH: '/synthetic/bin' }) : reject(Error(`shell exit ${code}`)));
    }),
  };
  const source = patched ? patchShellEnvironmentSource(shellEnvSource) : shellEnvSource;
  const run = vm.runInNewContext(`${source};resolveEnv`, context);
  const start = performance.now();
  const result = run({ getValue: () => block || hang ? 1 : 3 }, { trace: (...args) => traces.push(args) }, {}, {})
    .then(env => ({ ok: true, env }), error => ({ ok: false, error: error.message }));
  if (block) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2200);
    // Exercise the problematic, permitted ordering explicitly. Windows can
    // drain child close before overdue timers; relying on host ordering would
    // accidentally skip the regression. The child and elapsed time stay real.
    assert.equal(timers.size, 1, 'resolver deadline must still be pending during the stall');
    const [handle, callback] = timers.entries().next().value;
    unschedule(handle);
    callback();
  }
  try { return { ...await result, seconds: (performance.now() - start) / 1000, traces, cancelled }; }
  finally {
    for (const child of children) child.kill();
    for (const handle of timers.keys()) unschedule(handle);
  }
}

test('reproduces the original false timeout after the parent event loop stalls despite a completed child', async () => {
  const result = await execute({ patched: false, block: true });
  assert.equal(result.ok, false);
  assert.match(result.error, /timeout/);
});

test('macOS drains a queued successful child result after a stall and cancels the grace timer', async () => {
  const result = await execute({ block: true });
  assert.equal(result.ok, true);
  assert.equal(result.env.TEST_PATH, '/synthetic/bin');
  assert.equal(result.traces.length, 1);
  assert.equal(result.traces[0][1].graceMs, 1000);
  assert.equal(result.cancelled.length, 0);
  assert.ok(result.seconds < 3.1, 'completed child must not wait out the extra grace');
});

test('healthy resolution and nonzero shell exits retain their original outcomes', async () => {
  const healthy = await execute();
  assert.equal(healthy.ok, true);
  assert.equal(healthy.traces.length, 0);
  const failed = await execute({ exit: 7 });
  assert.equal(failed.ok, false);
  assert.match(failed.error, /shell exit 7/);
});

test('a genuinely hanging shell still times out at the configured deadline without a main-loop stall', async () => {
  const result = await execute({ hang: true });
  assert.equal(result.ok, false);
  assert.match(result.error, /timeout/);
  assert.equal(result.traces.length, 0);
  assert.equal(result.cancelled.length, 1);
  assert.ok(result.seconds < 1.9);
});

test('a still-hanging shell receives at most one second of grace after a macOS stall', async () => {
  const result = await execute({ block: true, hang: true });
  assert.equal(result.ok, false);
  assert.equal(result.traces.length, 1);
  assert.equal(result.cancelled.length, 1);
  assert.ok(result.seconds >= 3.1 && result.seconds < 4.5);
});

test('other platforms retain the original overdue timeout behavior', async () => {
  const result = await execute({ block: true, platform: 'linux' });
  assert.equal(result.ok, false);
  assert.equal(result.traces.length, 0);
});

test('matcher is idempotent and rejects ambiguous, partial or changed cancellation semantics', () => {
  const patched = patchShellEnvironmentSource(shellEnvSource);
  assert.equal(patchShellEnvironmentSource(patched), patched);
  assert.ok(patchShellEnvironmentSource(shellEnvSource.replace('dispose(true)', 'dispose(!0)')).includes(SHELL_ENV_MARKER));
  assert.throws(() => patchShellEnvironmentSource(shellEnvSource + shellEnvSource), /exactly one/);
  assert.throws(() => patchShellEnvironmentSource(shellEnvSource.replace('dispose(true)', 'dispose(false)')), /semantics changed/);
  assert.throws(() => patchShellEnvironmentSource(shellEnvSource.replace('clearTimeout(timer)', 'void timer')), /cleanup/);
  assert.throws(() => patchShellEnvironmentSource(shellEnvSource + SHELL_ENV_MARKER), /Partial/);
  assert.throws(() => patchShellEnvironmentSource(patched.replace('1000);', '2000);')), /Partial/);
});

test('main-process patch updates its product checksum and rollback restores both exact originals', () => {
  const appRoot = mkdtempSync(join(tmpdir(), 'ccursor-shell-env-'));
  try {
    const mainJs = join(appRoot, 'out/main.js'), productJson = join(appRoot, 'product.json');
    mkdirSync(join(appRoot, 'out'));
    const product = '{ "commit": "synthetic", "checksums": { "main.js": "before" } }\n';
    writeFileSync(mainJs, shellEnvSource); writeFileSync(productJson, product);
    const paths = { appRoot, mainJs, productJson };
    patchShellEnvironment(paths);
    const patched = readFileSync(mainJs);
    const hash = createHash('sha256').update(patched).digest('base64').replace(/=+$/, '');
    assert.equal(JSON.parse(readFileSync(productJson)).checksums['main.js'], hash);
    patchShellEnvironment(paths);
    restoreShellEnvironment(paths);
    assert.equal(readFileSync(mainJs, 'utf8'), shellEnvSource);
    assert.equal(readFileSync(productJson, 'utf8'), product);
  } finally { rmSync(appRoot, { recursive: true, force: true }); }
});

// Local live-bundle verification is performed by `ccursor check` and the
// installation transaction; these tests never mutate an installed application.
