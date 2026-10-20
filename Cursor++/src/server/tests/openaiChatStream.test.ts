import type { ChatCompletionChunk } from 'openai/resources/chat/completions'
import type { LLMStreamEvent, LLMStreamRequest } from '../handlers/llm/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { OpenAIChatProvider } from '../handlers/llm/openai-chat'

const { createCompletion } = vi.hoisted(() => ({ createCompletion: vi.fn() }))

vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: createCompletion } }
  },
}))

function chunk(
  toolCalls: NonNullable<ChatCompletionChunk.Choice.Delta['tool_calls']>,
  finishReason: ChatCompletionChunk.Choice['finish_reason'] = null,
): ChatCompletionChunk {
  return {
    id: 'completion-test',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [{ index: 0, delta: { tool_calls: toolCalls }, finish_reason: finishReason }],
  }
}

function mockChunks(chunks: ChatCompletionChunk[]): void {
  createCompletion.mockResolvedValue((async function* () {
    yield* chunks
  })())
}

async function collectEvents(overrides: Partial<LLMStreamRequest> = {}): Promise<LLMStreamEvent[]> {
  const provider = new OpenAIChatProvider({
    id: 'test-openai-chat',
    name: 'Test OpenAI Chat',
    type: 'openai-chat',
    baseUrl: 'https://invalid.example/v1',
    auth: { kind: 'apiKey', value: 'dummy-test-key' },
    models: [],
  })
  const events: LLMStreamEvent[] = []
  for await (const event of provider.stream({ model: 'test-model', messages: [], ...overrides }))
    events.push(event)
  return events
}

describe('openai chat streaming adapter', () => {
  it.each([['length', 'max_tokens'], ['content_filter', 'content_filter']] as const)('preserves abnormal completion %s', async (reason, expected) => {
    mockChunks([chunk([], reason)])
    expect((await collectEvents()).at(-1)).toMatchObject({ type: 'done', stopReason: expected })
  })
  beforeEach(() => {
    createCompletion.mockReset()
  })

  it('starts a tool call when its name arrives after its id', async () => {
    mockChunks([
      chunk([{ index: 0, id: 'call-a' }]),
      chunk([{ index: 0, function: { name: 'read_file' } }]),
      chunk([{ index: 0, function: { arguments: '{"path":"a.ts"}' } }], 'tool_calls'),
    ])

    expect(await collectEvents()).toEqual([
      { type: 'tool_use_start', id: 'call-a', name: 'read_file' },
      { type: 'tool_use_delta', id: 'call-a', input: '{"path":"a.ts"}' },
      { type: 'tool_use_done', id: 'call-a', arguments: '{"path":"a.ts"}' },
      { type: 'done', stopReason: 'tool_use', usage: { inputTokens: 0, outputTokens: 0 } },
    ])
  })

  it('buffers arguments until a tool call has both an id and a name', async () => {
    mockChunks([
      chunk([{ index: 0, function: { name: 'read_file', arguments: '{"path":' } }]),
      chunk([{ index: 0, id: 'call-a', function: { arguments: '"a.ts"}' } }], 'tool_calls'),
    ])

    expect(await collectEvents()).toEqual([
      { type: 'tool_use_start', id: 'call-a', name: 'read_file' },
      { type: 'tool_use_delta', id: 'call-a', input: '{"path":"a.ts"}' },
      { type: 'tool_use_done', id: 'call-a', arguments: '{"path":"a.ts"}' },
      { type: 'done', stopReason: 'tool_use', usage: { inputTokens: 0, outputTokens: 0 } },
    ])
  })

  it('keeps interleaved tool calls separate and starts each one only once', async () => {
    mockChunks([
      chunk([
        { index: 0, id: 'call-a', function: { name: 'read_file', arguments: '{"path":' } },
        { index: 1, id: 'call-b' },
      ]),
      chunk([
        { index: 1, function: { name: 'list_dir', arguments: '{}' } },
        { index: 0, function: { arguments: '"a.ts"}' } },
      ], 'tool_calls'),
    ])

    const events = await collectEvents()
    expect(events.filter(event => event.type === 'tool_use_start')).toEqual([
      { type: 'tool_use_start', id: 'call-a', name: 'read_file' },
      { type: 'tool_use_start', id: 'call-b', name: 'list_dir' },
    ])
    expect(events.filter(event => event.type === 'tool_use_done')).toEqual([
      { type: 'tool_use_done', id: 'call-a', arguments: '{"path":"a.ts"}' },
      { type: 'tool_use_done', id: 'call-b', arguments: '{}' },
    ])
  })

  it.each([undefined, 'priority', 'default'] as const)('forwards service tier %s while preserving Max effort', async (serviceTier) => {
    mockChunks([])

    await collectEvents({ serviceTier, thinking: true, thinkingLevel: 'max' })

    const params = createCompletion.mock.calls[0]?.[0]
    expect(params.reasoning_effort).toBe('max')
    if (serviceTier === undefined)
      expect(params).not.toHaveProperty('service_tier')
    else expect(params.service_tier).toBe(serviceTier)
  })
})
