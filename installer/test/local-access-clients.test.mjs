import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { buildHookPayload, prepareRendererSource } from '../src/patch-inject.js';
import { buildNodeHttp11RouterPayload } from '../src/node-http11-router.js';

const token = 'a'.repeat(64);
const config = { server: { host: '127.0.0.1', port: 40001 }, collector: { host: '127.0.0.1', port: 40002 } };

test('renderer bootstrap authenticates local fetch and SSE without sending credentials to official endpoints', async () => {
  const calls = [], events = [], logs = [];
  const sandbox = {
    Headers, Request, URL, Set, Promise,
    window: { vscodeWindowId: 3 },
    document: { body: null },
    setTimeout: () => 0,
    console: { log: (...args) => logs.push(args), warn: (...args) => logs.push(args) },
    EventSource: class { constructor(url) { events.push(url); } addEventListener() {} },
    fetch: async (url, init = {}) => {
      calls.push({ url, init });
      if (typeof url === 'string' && url.endsWith('/byok/session')) return new Response(JSON.stringify({ token }));
      return new Response('{}');
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(buildHookPayload(true, config), sandbox);
  await sandbox.fetch('http://127.0.0.1:40001/health');
  const bodyRequest = new Request('http://127.0.0.1:40001/rpc', { method: 'POST', headers: { 'content-type': 'application/connect+proto', authorization: 'synthetic-session' }, body: 'fixture body' });
  await sandbox.fetch(bodyRequest);
  const requestCall = calls.find(c => c.url === bodyRequest);
  assert.equal(new Headers(requestCall.init.headers).get('content-type'), 'application/connect+proto');
  assert.equal(new Headers(requestCall.init.headers).get('authorization'), 'synthetic-session');
  assert.equal(new Headers(requestCall.init.headers).get('x-ccursor-token'), token);
  assert.equal(await requestCall.url.text(), 'fixture body');
  await sandbox.fetch('https://official.example/unmodified', { headers: { other: 'value' } });
  assert.equal(new Headers(calls.find(c => c.url.endsWith('/health')).init.headers).get('x-ccursor-token'), token);
  assert.equal(new Headers(calls.find(c => typeof c.url === 'string' && c.url.includes('official.example')).init.headers).has('x-ccursor-token'), false);
  assert.deepEqual(events, [`http://127.0.0.1:40001/byok/events?access_token=${token}`]);
  assert.equal(JSON.stringify(logs).includes(token), false);
});

test('renderer authentication retries startup races before sending a local request', async () => {
  let attempts = 0, localCalls = 0;
  const sandbox = { Headers, Request, URL, Set, Promise, window: {}, document: { body: null },
    setTimeout: callback => queueMicrotask(callback), console: { log() {}, warn() {} },
    EventSource: class { addEventListener() {} },
    fetch: async url => {
      if (url.endsWith('/byok/session')) {
        if (++attempts < 3) throw Error('server is starting');
        return new Response(JSON.stringify({ token }));
      }
      localCalls++;
      return new Response('{}');
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(buildHookPayload(true, config), sandbox);
  await sandbox.fetch('http://127.0.0.1:40001/health');
  assert.equal(attempts, 3);
  assert.equal(localCalls, 1);
});

test('Agent HTTP router authenticates redirected requests and leaves unrelated upstreams untouched', () => {
  const requests = [];
  const http = { request: (...args) => { requests.push(args); return { end() {} }; }, get() {} };
  const https = { request: http.request, get() {} };
  const modules = {
    http, https,
    fs: { readFileSync: path => path.endsWith('routes.json') ? JSON.stringify({ server: config.server, redirect: ['agent.v1.AgentService'] }) : JSON.stringify({ token }), watchFile() {} },
    path: { join: (...args) => args.join('/') }, os: { homedir: () => '/isolated' }, module: { syncBuiltinESMExports() {} },
  };
  const sandbox = { require: name => modules[name], process: { env: {} }, URL, Headers, Set, console: { log() {}, warn() {} } };
  vm.createContext(sandbox);
  vm.runInContext(buildNodeHttp11RouterPayload({ guardMarker: 'fixture', processLabel: 'fixture' }), sandbox);
  https.request('https://api2.cursor.sh/agent.v1.AgentService/RunSSE', { headers: { authorization: 'upstream-session' } });
  https.request('https://other.example/unmodified', { headers: {} });
  assert.equal(requests[0][0], 'http://127.0.0.1:40001/agent.v1.AgentService/RunSSE');
  assert.equal(requests[0][1].headers['x-ccursor-token'], token);
  assert.equal(requests[0][1].headers.authorization, 'upstream-session');
  assert.equal(requests[1][0], 'https://other.example/unmodified');
  assert.equal(requests[1][1].headers['x-ccursor-token'], undefined);
});

test('known legacy renderer hook is upgraded while malformed hooks remain rejected', () => {
  const delegate = 'function client(s,t){return dispatch(s,(typeof globalThis.__byokWrapTransport==="function"?globalThis.__byokWrapTransport(t,s.typeName):t))}';
  const old = `/* CURSOR-BYOK-HOOK-START */legacy()/* CURSOR-BYOK-HOOK-END */;${delegate}`;
  assert.equal(prepareRendererSource(old), 'function client(s,t){return dispatch(s,t)}');
  const partial = '/* CURSOR-BYOK-HOOK-START */broken();';
  assert.equal(prepareRendererSource(partial), partial);
});
