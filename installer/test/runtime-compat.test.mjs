import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { patchHttp1TimeoutSource, patchPunycodeSource, patchRuntimeCompat, restoreRuntimeCompat, isRuntimeCompatPatched, HTTP1_TIMEOUT_MARKER, PUNYCODE_MARKER } from '../src/patch-runtime-compat.js';
import { shellEnvSource } from './fixtures/shell-env.mjs';

const call = 'this.transportFactory.setHttp2SessionEstablishTimeoutMs(await async function(t){try{const r=await t.getDynamicConfigValue("http2_session_establish_timeout"),e=r?.timeoutMs;return"number"==typeof e&&Number.isFinite(e)?e<=0?0:Math.max(e,5e3):2e4}catch(r){return t.log.error("Failed to get the HTTP/2 session establishment timeout from Statsig",r),2e4}}(this.host))';

async function evaluate(disabled, config, throws = false) {
  let lookups = 0, errors = 0, timeout;
  const fn = new Function(`return async function(){${patchHttp1TimeoutSource(call)}}`)();
  await fn.call({
    host: {
      isHttp2Disabled: () => disabled,
      getDynamicConfigValue: async () => { lookups++; if (throws) throw Error('missing config'); return config; },
      log: { error: () => errors++ },
    },
    transportFactory: { setHttp2SessionEstablishTimeoutMs: value => { timeout = value; } },
  });
  return { lookups, errors, timeout };
}

test('HTTP/1.1 avoids an irrelevant dynamic config lookup and retains the 20s default', async () => {
  assert.deepEqual(await evaluate(true, undefined, true), { lookups: 0, errors: 0, timeout: 20000 });
});

test('HTTP/2 keeps configured timeout, lower bound, disabled timeout and missing-config errors', async () => {
  assert.deepEqual(await evaluate(false, { timeoutMs: 8000 }), { lookups: 1, errors: 0, timeout: 8000 });
  assert.equal((await evaluate(false, { timeoutMs: 1 })).timeout, 5000);
  assert.equal((await evaluate(false, { timeoutMs: 0 })).timeout, 0);
  assert.deepEqual(await evaluate(false, undefined, true), { lookups: 1, errors: 1, timeout: 20000 });
});

test('timeout patch is idempotent and refuses ambiguous or changed semantics', () => {
  const patched = patchHttp1TimeoutSource(call);
  assert.equal(patchHttp1TimeoutSource(patched), patched);
  assert.ok(patched.includes(HTTP1_TIMEOUT_MARKER));
  assert.throws(() => patchHttp1TimeoutSource(call + ';' + call), /exactly one/);
  assert.throws(() => patchHttp1TimeoutSource(call.replace('http2_session_establish_timeout', 'different_config')), /semantics changed/);
});

test('retrieval inlines the userland library without extra files or Node module interception', () => {
  const source = 'module.exports=require("punycode");require("node:url");';
  const patched = patchPunycodeSource(source);
  assert.ok(patched.includes(PUNYCODE_MARKER));
  assert.ok(patched.includes('Copyright'));
  const require = createRequire(import.meta.url);
  const exported = { exports: {} };
  new Function('module', 'require', patched)(exported, require);
  assert.equal(exported.exports.toASCII('münich.example'), 'xn--mnich-kva.example');
  assert.ok(patched.endsWith(';require("node:url");'));
  assert.equal(patchPunycodeSource(patched), patched);
  assert.throws(() => patchPunycodeSource('require("node:url")'), /exactly one/);
});

test('vendored punycode 2.3.1 preserves the Unicode/domain and low-level codec API', () => {
  const require = createRequire(import.meta.url);
  const punycode = require('../assets/vendor/punycode.cjs');
  assert.equal(punycode.version, '2.3.1');
  assert.equal(punycode.toASCII('münich.example'), 'xn--mnich-kva.example');
  assert.equal(punycode.toUnicode('xn--fiqs8s.example'), '中国.example');
  assert.equal(punycode.decode(punycode.encode('你好😀')), '你好😀');
  assert.deepEqual(punycode.ucs2.decode('😀'), [128512]);
  assert.equal(punycode.ucs2.encode([128512]), '😀');
});

test('file patch and rollback restore both agent transports and retrieval exactly', () => {
  const root = mkdtempSync(join(tmpdir(), 'ccursor-runtime-'));
  try {
    const appRoot = join(root, 'app');
    const alwaysLocalMain = join(appRoot, 'extensions/cursor-always-local/dist/main.js');
    const agentHostMain = join(appRoot, 'extensions/cursor-agent-host/dist/main.js');
    const retrieval = join(appRoot, 'extensions/cursor-retrieval/dist/main.js');
    const mainJs = join(appRoot, 'out/main.js');
    const productJson = join(appRoot, 'product.json');
    const network = `/* agent.v1.AgentService RunSSE BidiAppend AiConnectTransportHandler HTTP/1.1 transport created with network settings */\n${call}`;
    for (const [path, content] of [[alwaysLocalMain, call], [agentHostMain, network], [retrieval, 'module.exports=require("punycode");'], [mainJs, shellEnvSource], [productJson, '{}']]) {
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, content);
    }
    const paths = { appRoot, alwaysLocalMain, agentHostMain, mainJs, productJson };
    patchRuntimeCompat(paths);
    assert.equal(isRuntimeCompatPatched(paths), true);
    patchRuntimeCompat(paths);
    assert.equal(readdirSync(join(alwaysLocalMain, '..')).filter(name => name.includes('backup') && !name.endsWith('.metadata.json')).length, 1);
    restoreRuntimeCompat(paths);
    assert.equal(readFileSync(alwaysLocalMain, 'utf8'), call);
    assert.equal(readFileSync(agentHostMain, 'utf8'), network);
    assert.equal(readFileSync(retrieval, 'utf8'), 'module.exports=require("punycode");');
    assert.equal(readFileSync(mainJs, 'utf8'), shellEnvSource);
    assert.deepEqual(readdirSync(join(retrieval, '..')), ['main.js']);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
