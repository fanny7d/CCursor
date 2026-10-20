import type { ProviderEntry } from '../data/defaults'
import type { LLMProvider } from '../handlers/llm/types'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { afterEach, expect, it, vi } from 'vitest'
import { createEphemeralSession, markSessionClosed, pushSessionMessage } from '../handlers/agent/session'
import { translateStream } from '../handlers/agent/stream'
import { AnthropicProvider } from '../handlers/llm/anthropic'
import { streamWithCancellation } from '../handlers/llm/cancellation'
import { GeminiProvider } from '../handlers/llm/gemini'
import { OpenAIChatProvider } from '../handlers/llm/openai-chat'
import { OpenAIResponsesProvider } from '../handlers/llm/openai-responses'

afterEach(() => vi.useRealTimers())

for (const [type, Provider] of [
  ['openai-chat', OpenAIChatProvider],
  ['openai-responses', OpenAIResponsesProvider],
  ['anthropic', AnthropicProvider],
  ['gemini', GeminiProvider],
] as const) {
  it(`${type}: cancels an idle real HTTP upstream before any token arrives`, async () => {
    let requests = 0
    let closed = false
    let seen!: () => void
    const connected = new Promise<void>((resolve) => {
      seen = resolve
    })
    const upstream = createServer((_req, res) => {
      requests++
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write(': idle\n\n')
      res.on('close', () => {
        closed = true
      })
      seen()
    })
    upstream.listen(0, '127.0.0.1')
    await once(upstream, 'listening')
    const port = (upstream.address() as { port: number }).port
    const entry: ProviderEntry = { id: 'isolated', name: 'isolated', type, baseUrl: `http://127.0.0.1:${port}/v1`, auth: { kind: 'apiKey', value: 'synthetic-only' }, models: [] }
    const session = createEphemeralSession('isolated-cancel')
    const stream = streamWithCancellation(new Provider(entry), { model: 'test-model', messages: [{ role: 'user', content: 'test' }], signal: session.controller.signal })
    const pending = stream.next()
    const rejection = expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    try {
      await connected
      pushSessionMessage(session, { conversationAction: { cancelAction: { reason: 'user_stopped_generation' } } })
      await rejection
      await vi.waitFor(() => expect(closed).toBe(true), { timeout: 2000 })
      expect(requests).toBe(1)
    }
    finally {
      session.controller.abort()
      upstream.closeAllConnections()
      await new Promise<void>(resolve => upstream.close(() => resolve()))
    }
  }, 10000)
}

it('consumer stopping on a heartbeat cancels the pending provider iterator', async () => {
  let signal!: AbortSignal
  let cleaned = false
  const provider: LLMProvider = {
    name: 'slow',
    async* stream(request) {
      signal = request.signal!
      try {
        await new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
      }
      finally { cleaned = true }
    },
  }
  const frames = translateStream(streamWithCancellation(provider, { model: 'test', messages: [] }), '1', undefined, 5)
  const iterator = frames[Symbol.asyncIterator]()
  await iterator.next()
  await iterator.return?.()
  await vi.waitFor(() => expect(cleaned).toBe(true))
  expect(signal.aborted).toBe(true)
})

it('session disconnect aborts immediately and a pre-cancelled run sends no upstream request', async () => {
  const session = createEphemeralSession('closed')
  markSessionClosed(session)
  const stream = vi.fn()
  await expect(streamWithCancellation({ name: 'test', stream }, { model: 'test', messages: [], signal: session.controller.signal }).next()).rejects.toMatchObject({ name: 'AbortError' })
  expect(stream).not.toHaveBeenCalled()
})

it('normal completion cleans up the iterator and heartbeat timer', async () => {
  vi.useFakeTimers()
  let cleaned = false
  const events = (async function* () {
    try {
      yield { type: 'text_delta' as const, text: 'ok' }
    }
    finally { cleaned = true }
  })()
  for await (const _frame of translateStream(events)) { /* consume */ }
  expect(cleaned).toBe(true)
  expect(vi.getTimerCount()).toBe(0)
})
