import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '@connectrpc/connect'
import { createConnectTransport } from '@connectrpc/connect-node'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { AiService } from '../gen/aiserver_v1_pb'

let directory: string | undefined
let previous: string | undefined
let server: typeof import('../index') | undefined

// Cold Vite transforms include all four SDKs and compete with the other test
// workers on CI. Give module preparation its own budget, not the HTTP/SSE test's.
beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'ccursor-embedded-'))
  previous = process.env.CCURSOR_DATA_DIR
  process.env.CCURSOR_DATA_DIR = directory
  vi.resetModules()
  const { getCcursorDir } = await import('../config/paths')
  // Assert the actual production path resolver before writing any fixture.
  expect(getCcursorDir()).toBe(directory)
  writeFileSync(join(directory, 'providers.json'), JSON.stringify({ $schemaVersion: 1, providers: [{
    id: 'isolated-provider',
    name: 'isolated',
    type: 'openai-chat',
    baseUrl: 'https://example.invalid/v1',
    auth: { kind: 'apiKey', value: 'synthetic-only' },
    models: [{ id: 'isolated-nas', apiModel: 'gpt-6-luna', displayName: 'isolated NAS', thinking: true, thinkingLevel: 'max', parameters: { effort: ['low', 'medium', 'high', 'xhigh', 'max'] } }],
  }] }), { mode: 0o600 })
  server = await import('../index')
}, 60000)

afterAll(() => {
  if (previous === undefined)
    delete process.env.CCURSOR_DATA_DIR
  else process.env.CCURSOR_DATA_DIR = previous
  if (directory)
    rmSync(directory, { recursive: true, force: true })
})

it('boots the complete embedded server with real SQLite and authenticated model / SSE / control calls', async () => {
  const { startServer, stopServer } = server!
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 10000)
  const request = (url: string, init?: RequestInit) => fetch(url, { ...init, signal: controller.signal })
  try {
    const address = await startServer({ host: '127.0.0.1', port: 0 })
    const base = `http://127.0.0.1:${address.port}`
    const health = await (await request(`${base}/health`)).json()
    expect(health.localAccessProtocol).toBe(1)
    const origin = 'vscode-file://vscode-app'
    expect((await request(`${base}/byok/session`, { headers: { origin: 'https://evil.example' } })).status).toBe(403)
    const { token } = await (await request(`${base}/byok/session`, { headers: { origin } })).json()
    expect(JSON.parse(readFileSync(join(directory!, 'local-access.json'), 'utf8')).token).toBe(token)
    const client = createClient(AiService, createConnectTransport({ baseUrl: base, httpVersion: '1.1' }))
    await expect(client.availableModels({}, { signal: controller.signal })).rejects.toThrow()
    const models = await client.availableModels({}, { headers: { 'x-ccursor-token': token }, signal: controller.signal })
    expect(models.modelNames).toContain('isolated-nas')
    const stream = await request(`${base}/byok/events?access_token=${token}`, { headers: { origin } })
    expect(stream.status).toBe(200)
    const reader = stream.body!.getReader()
    let received = ''
    while (!received.includes('event: routes')) {
      const chunk = await reader.read()
      if (chunk.done)
        break
      received += new TextDecoder().decode(chunk.value)
    }
    expect(received).toContain('event: routes')
    const toggle = await request(`${base}/byok/toggle`, { method: 'POST', headers: { 'x-ccursor-token': token, origin } })
    expect(toggle.status).toBe(200)
    let updates = ''
    while (!updates.includes('event: refresh')) {
      const chunk = await reader.read()
      if (chunk.done)
        break
      updates += new TextDecoder().decode(chunk.value)
    }
    expect(updates).toContain('event: routes')
    expect(updates).toContain('event: refresh')
    await reader.cancel()
    const diagnostic = await (await request(`${base}/byok/diagnostics`, { headers: { 'x-ccursor-token': token } })).json()
    expect(diagnostic).toHaveProperty('outcomes.completed')
    const saved = JSON.parse(readFileSync(join(directory!, 'providers.json'), 'utf8'))
    expect(saved.providers[0].models[0].thinkingLevel).toBe('max')
    expect(saved.providers[0].baseUrl).toBe('https://example.invalid/v1')
  }
  finally {
    controller.abort()
    clearTimeout(timeout)
    await stopServer()
  }
}, 15000)
