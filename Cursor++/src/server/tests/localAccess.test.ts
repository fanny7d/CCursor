import { once } from 'node:events'
import { readFileSync, statSync } from 'node:fs'
import * as http from 'node:http'
import { join } from 'node:path'
import cors from '@fastify/cors'
import Fastify from 'fastify'
import { expect, it } from 'vitest'
import { ensureLocalAccessToken } from '../config/localAccess'
import { getCcursorDir } from '../config/paths'
import { isRendererOrigin, registerLocalAccess } from '../localAccess'

it('protects control, RPC and SSE requests while allowing authenticated native and renderer clients', async () => {
  const token = ensureLocalAccessToken()
  expect(ensureLocalAccessToken()).toBe(token)
  expect(JSON.parse(readFileSync(join(getCcursorDir(), 'local-access.json'), 'utf8')).token).toBe(token)
  if (process.platform !== 'win32')
    expect(statSync(join(getCcursorDir(), 'local-access.json')).mode & 0o777).toBe(0o600)
  const server = Fastify()
  registerLocalAccess(server, token)
  await server.register(cors, { origin: (origin, cb) => cb(null, isRendererOrigin(origin)) })
  let changes = 0
  server.get('/health', () => ({ ok: true }))
  server.post('/byok/toggle', () => ({ changes: ++changes }))
  server.post('/agent.v1.AgentService/RunSSE', () => ({ ok: true }))
  server.get('/byok/events', req => ({ url: req.url }))
  await server.listen({ host: '127.0.0.1', port: 0 })
  const base = `http://127.0.0.1:${(server.server.address() as { port: number }).port}`
  try {
    expect((await fetch(`${base}/health`)).status).toBe(200)
    const origin = 'vscode-file://vscode-app'
    expect((await fetch(`${base}/byok/session`)).status).toBe(401)
    for (const hostile of ['https://evil.example', 'null', 'https://vscode-app', 'vscode-file://evil']) {
      expect((await fetch(`${base}/byok/session`, { headers: { origin: hostile } })).status).toBe(403)
      expect((await fetch(`${base}/byok/toggle`, { method: 'POST', headers: { 'origin': hostile, 'x-ccursor-token': token } })).status).toBe(403)
    }
    const bootstrap = await fetch(`${base}/byok/session`, { headers: { origin } })
    expect(await bootstrap.json()).toEqual({ token })
    expect(bootstrap.headers.get('cache-control')).toBe('no-store')
    expect(bootstrap.headers.get('access-control-allow-origin')).toBe(origin)
    expect((await fetch(`${base}/byok/toggle`, { method: 'POST' })).status).toBe(401)
    expect((await fetch(`${base}/byok/toggle?access_token=${token}`, { method: 'POST' })).status).toBe(401)
    expect((await fetch(`${base}/byok/toggle`, { method: 'POST', headers: { origin, 'x-ccursor-token': token } })).status).toBe(200)
    expect((await fetch(`${base}/agent.v1.AgentService/RunSSE`, { method: 'POST', headers: { 'x-ccursor-token': token } })).status).toBe(200)
    expect((await fetch(`${base}/byok/events`)).status).toBe(401)
    const sse = await fetch(`${base}/byok/events?access_token=${token}&windowId=1`, { headers: { origin } })
    expect(sse.status).toBe(200)
    expect(await sse.json()).toEqual({ url: '/byok/events?windowId=1' })
    expect(changes).toBe(1)
    const preflight = await fetch(`${base}/byok/toggle`, { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'x-ccursor-token' } })
    expect(preflight.status).toBe(204)
    const badHost = http.get(`${base}/health`, { headers: { host: 'evil.example' } })
    const [response] = await once(badHost, 'response')
    expect(response.statusCode).toBe(403)
    response.resume()
  }
  finally {
    await server.close()
  }
})
