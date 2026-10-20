import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClient } from '@connectrpc/connect'
import { createConnectTransport } from '@connectrpc/connect-node'
import { expect, it, vi } from 'vitest'
import { AiService } from '../gen/aiserver_v1_pb'

it('boots the complete embedded server with real SQLite and authenticated model / SSE / control calls', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'ccursor-embedded-'))
  const previous = process.env.CCURSOR_DATA_DIR
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
  const { startServer, stopServer } = await import('../index')
  const controller = new AbortController()
  try {
    const address = await startServer({ host: '127.0.0.1', port: 0 })
    const base = `http://127.0.0.1:${address.port}`
    const health = await (await fetch(`${base}/health`)).json()
    expect(health.localAccessProtocol).toBe(1)
    const origin = 'vscode-file://vscode-app'
    expect((await fetch(`${base}/byok/session`, { headers: { origin: 'https://evil.example' } })).status).toBe(403)
    const { token } = await (await fetch(`${base}/byok/session`, { headers: { origin } })).json()
    expect(JSON.parse(readFileSync(join(directory, 'local-access.json'), 'utf8')).token).toBe(token)
    const client = createClient(AiService, createConnectTransport({ baseUrl: base, httpVersion: '1.1' }))
    await expect(client.availableModels({})).rejects.toThrow()
    const models = await client.availableModels({}, { headers: { 'x-ccursor-token': token } })
    expect(models.modelNames).toContain('isolated-nas')
    const stream = await fetch(`${base}/byok/events?access_token=${token}`, { headers: { origin }, signal: controller.signal })
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
    const toggle = await fetch(`${base}/byok/toggle`, { method: 'POST', headers: { 'x-ccursor-token': token, origin } })
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
    controller.abort()
    const diagnostic = await (await fetch(`${base}/byok/diagnostics`, { headers: { 'x-ccursor-token': token } })).json()
    expect(diagnostic).toHaveProperty('outcomes.completed')
    const saved = JSON.parse(readFileSync(join(directory, 'providers.json'), 'utf8'))
    expect(saved.providers[0].models[0].thinkingLevel).toBe('max')
    expect(saved.providers[0].baseUrl).toBe('https://example.invalid/v1')
  }
  finally {
    controller.abort()
    await stopServer()
    if (previous === undefined)
      delete process.env.CCURSOR_DATA_DIR
    else process.env.CCURSOR_DATA_DIR = previous
    rmSync(directory, { recursive: true, force: true })
  }
}, 15000)
