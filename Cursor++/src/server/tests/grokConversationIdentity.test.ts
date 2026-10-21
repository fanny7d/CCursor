import type { ProviderEntry } from '../data/defaults'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { expect, it } from 'vitest'
import { AnthropicProvider } from '../handlers/llm/anthropic'

it('messages→Grok forwards stable per-chat identity on normal and beta requests without changing other models or explicit headers', async () => {
  const seen: Array<{ path?: string, identity?: string }> = []
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* consume body */ }
    seen.push({ path: req.url, identity: req.headers['x-grok-conv-id'] as string | undefined })
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const events = [
      { type: 'message_start', message: { id: 'synthetic', type: 'message', role: 'assistant', model: 'grok-4.7', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ]
    for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    res.end()
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = (server.address() as { port: number }).port
  const entry: ProviderEntry = { id: 'test', name: 'test', type: 'anthropic', baseUrl: `http://127.0.0.1:${port}`, auth: { kind: 'apiKey', value: 'synthetic-only' }, models: [] }
  const provider = new AnthropicProvider(entry)
  try {
    for (const request of [
      { model: 'grok-4.7', conversationId: 'chat-a' },
      { model: 'grok-4.7', conversationId: 'chat-a', thinking: true, thinkingLevel: 'high' as const },
      { model: 'grok-4.7', conversationId: 'chat-b' },
      { model: 'claude-sonnet-4-6', conversationId: 'chat-c' },
      { model: 'grok-4.7' },
    ]) {
      for await (const _ of provider.stream({ ...request, messages: [{ role: 'user', content: 'synthetic' }] })) { /* consume */ }
    }
    const custom = new AnthropicProvider({ ...entry, headers: { 'x-grok-conv-id': 'explicit-user-value' } })
    for await (const _ of custom.stream({ model: 'grok-4.7', conversationId: 'chat-d', messages: [{ role: 'user', content: 'synthetic' }] })) { /* consume */ }
    expect(seen.map(request => request.identity)).toEqual(['chat-a', 'chat-a', 'chat-b', undefined, undefined, 'explicit-user-value'])
    expect(seen[1].path).toContain('beta=true')
  }
  finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
