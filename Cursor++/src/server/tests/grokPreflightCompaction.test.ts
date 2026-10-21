import type { LLMStreamRequest } from '../handlers/llm/types'
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { loadProviders, setProvidersForTests } from '../config/providersStore'
import { closeAgentDatabase, initDatabase } from '../database/sqlite'
import { encodeBlob } from '../handlers/agent/blob'
import { cacheBlob } from '../handlers/agent/blobStore'
import { planCompaction } from '../handlers/agent/compactionStrategy'
import { handleConversationRun } from '../handlers/agent/conversationRuntime'
import { parseRunRequest } from '../handlers/agent/protocol'
import { resetProviderInstanceCache, resolveProviderRuntime } from '../handlers/llm/providerRuntime'

const baseline = loadProviders()
beforeAll(initDatabase)
beforeEach(() => {
  setProvidersForTests({ $schemaVersion: 1, providers: [
    ...baseline.providers,
    ...(['openai-responses', 'anthropic', 'openai-chat'] as const).map((type, index) => ({
      id: `boundary-${index}`,
      name: 'synthetic',
      type,
      baseUrl: 'https://example.invalid',
      auth: { kind: 'apiKey' as const, value: 'synthetic-only' },
      models: [{ id: `boundary-${index}`, displayName: 'synthetic', apiModel: index === 2 ? 'gpt-6-luna' : 'grok-4.7', thinking: false, contextTokenLimit: 200000 }],
    })),
  ] })
  resetProviderInstanceCache()
})
afterEach(() => {
  vi.restoreAllMocks()
  resetProviderInstanceCache()
  setProvidersForTests(baseline)
})
afterAll(closeAgentDatabase)

function request(modelId: string, hugeHistory: boolean) {
  const parsed = parseRunRequest({ runRequest: {
    conversationId: randomUUID(),
    modelDetails: { modelId },
    action: { userMessageAction: { userMessage: { text: 'LATEST_USER_ANCHOR: reply ACK without tools', mode: 'AGENT_MODE_AGENT' }, requestContext: {} } },
  } })
  const history = [
    { role: 'user', content: hugeHistory ? 'old-archive '.repeat(35000) : 'small history' },
    { role: 'assistant', content: hugeHistory ? 'old-response '.repeat(30000) : 'old answer' },
    ...Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `old short turn ${i}` })),
  ]
  parsed.historyBlobIds = history.map((message) => {
    const blob = encodeBlob(message)
    cacheBlob(blob.blobId, blob.blobData)
    return blob.blobId
  })
  return parsed
}

function spyStream(modelId: string, mainUsage = 20) {
  const calls: Array<{ summary: boolean, messages: LLMStreamRequest['messages'] }> = []
  const runtime = resolveProviderRuntime(modelId)
  vi.spyOn(runtime.provider, 'stream').mockImplementation(async function* (req) {
    const summary = !req.tools?.length
    calls.push({ summary, messages: structuredClone(req.messages) })
    yield { type: 'text_delta', text: summary ? 'Prior work summarized; retain the latest request.' : 'ACK' }
    yield { type: 'done', stopReason: 'end_turn', usage: { inputTokens: summary ? 10 : mainUsage, outputTokens: 5 } }
  })
  return calls
}

it('compacts oversized Grok history before the next model call and preserves the current user request', async () => {
  const calls = spyStream('boundary-0')
  const frames = []
  for await (const frame of handleConversationRun(request('boundary-0', true), null)) frames.push(frame)
  expect(calls[0]?.summary).toBe(true)
  expect(calls.at(-1)?.summary).toBe(false)
  expect(JSON.stringify(calls.at(-1)?.messages)).toContain('LATEST_USER_ANCHOR')
  expect(JSON.stringify(calls.at(-1)?.messages).length).toBeLessThan(200000)
  expect(frames.length).toBeGreaterThan(0)
})

it('compacts a text-only Grok response when model usage crosses the threshold without requiring any tool call', async () => {
  const calls = spyStream('boundary-0', 190000)
  for await (const _frame of handleConversationRun(request('boundary-0', false), null)) { /* consume */ }
  expect(calls.map(call => call.summary)).toEqual([false, true])
})

it.each(['boundary-1', 'boundary-2'])('leaves existing Messages/GPT boundary behavior unchanged: %s', async (modelId) => {
  const calls = spyStream(modelId, 190000)
  for await (const _frame of handleConversationRun(request(modelId, true), null)) { /* consume */ }
  expect(calls.map(call => call.summary)).toEqual([false])
})

it('never summarizes the newest user request away when there is no older body to compact', () => {
  const message = { role: 'user' as const, content: 'LATEST_USER_ANCHOR'.repeat(10000) }
  const plan = planCompaction([{ blobId: 'synthetic', raw: message, message }], { preserveLatestUser: true })
  expect(plan.summarizeEntries).toHaveLength(0)
  expect(plan.keepTail[0]?.message).toBe(message)
})
