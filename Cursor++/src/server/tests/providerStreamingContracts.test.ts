import type { LLMProvider, LLMStreamEvent } from '../handlers/llm/types'
import { beforeEach, expect, it, vi } from 'vitest'
import { GeminiProvider } from '../handlers/llm/gemini'
import { OpenAIResponsesProvider } from '../handlers/llm/openai-responses'

const mocks = vi.hoisted(() => ({ responses: vi.fn(), gemini: vi.fn() }))
vi.mock('openai', () => ({ default: class { responses = { create: mocks.responses } } }))
vi.mock('@google/genai', () => ({ GoogleGenAI: class { models = { generateContentStream: mocks.gemini } }, ThinkingLevel: { MINIMAL: 'MINIMAL', LOW: 'LOW', MEDIUM: 'MEDIUM', HIGH: 'HIGH' } }))

const entry = { id: 'fixture', name: 'fixture', baseUrl: '', auth: { kind: 'apiKey' as const, value: 'synthetic-only' }, models: [] }
function fakeStream(events: unknown[]) {
  return (async function* () {
    yield* events
  })()
}
async function collect(provider: LLMProvider, signal?: AbortSignal) {
  const events: LLMStreamEvent[] = []
  for await (const event of provider.stream({ model: 'fixture', messages: [], thinking: true, thinkingLevel: 'max', serviceTier: 'priority', signal }))
    events.push(event)
  return events
}
beforeEach(() => vi.clearAllMocks())

it.each(['max_output_tokens', 'content_filter'])('responses preserves incomplete reason %s and its usage', async (reason) => {
  mocks.responses.mockResolvedValue(fakeStream([{ type: 'response.incomplete', response: { incomplete_details: { reason }, usage: { input_tokens: 7, output_tokens: 9 } } }]))
  const signal = new AbortController().signal
  const events = await collect(new OpenAIResponsesProvider({ ...entry, type: 'openai-responses' }), signal)
  expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: reason === 'content_filter' ? 'content_filter' : 'max_tokens', usage: { inputTokens: 7, outputTokens: 9 } })
  expect(mocks.responses.mock.calls[0][0]).toMatchObject({ reasoning: { effort: 'max' }, service_tier: 'priority' })
  expect(mocks.responses.mock.calls[0][1]).toEqual({ signal })
})

it('responses retains complete tool call arguments for the next round', async () => {
  mocks.responses.mockResolvedValue(fakeStream([
    { type: 'response.output_item.added', item: { type: 'function_call', id: 'item', call_id: 'call', name: 'read_file' } },
    { type: 'response.function_call_arguments.delta', item_id: 'item', delta: '{"path":"a"}' },
    { type: 'response.output_item.done', item: { type: 'function_call', id: 'item', call_id: 'call', name: 'read_file', arguments: '{"path":"a"}' } },
    { type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 1, output_tokens: 2 } } },
  ]))
  const events = await collect(new OpenAIResponsesProvider({ ...entry, type: 'openai-responses' }))
  expect(events).toContainEqual({ type: 'tool_use_start', id: 'call', name: 'read_file' })
  expect(events).toContainEqual({ type: 'tool_use_done', id: 'call', arguments: '{"path":"a"}' })
  expect(events.at(-1)).toMatchObject({ type: 'done', stopReason: 'tool_use' })
})

it.each(['MAX_TOKENS', 'SAFETY', 'BLOCKLIST'])('gemini preserves abnormal completion %s even without content parts', async (finishReason) => {
  mocks.gemini.mockResolvedValue(fakeStream([{ candidates: [{ finishReason }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 4 } }]))
  const signal = new AbortController().signal
  const events = await collect(new GeminiProvider({ ...entry, type: 'gemini' }), signal)
  expect(events.at(-1)).toMatchObject({ stopReason: finishReason === 'MAX_TOKENS' ? 'max_tokens' : 'content_filter', usage: { inputTokens: 3, outputTokens: 4 } })
  expect(mocks.gemini.mock.calls[0][0].config).toMatchObject({ abortSignal: signal, thinkingConfig: { thinkingLevel: 'HIGH' } })
})

it('gemini streams tool calls and keeps its existing Max-to-HIGH mapping', async () => {
  mocks.gemini.mockResolvedValue(fakeStream([{ candidates: [{ content: { parts: [{ functionCall: { id: 'call', name: 'read_file', args: { path: 'a' } } }] }, finishReason: 'STOP' }] }]))
  const events = await collect(new GeminiProvider({ ...entry, type: 'gemini' }))
  expect(events).toContainEqual({ type: 'tool_use_start', id: 'call', name: 'read_file' })
  expect(events).toContainEqual({ type: 'tool_use_delta', id: 'call', input: '{"path":"a"}' })
  expect(events.at(-1)).toMatchObject({ stopReason: 'tool_use' })
})
