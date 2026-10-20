import { expect, it } from 'vitest'
import { setProvidersForTests } from '../config/providersStore'
import { translateStream } from '../handlers/agent/stream'
import { makeProviderError } from '../handlers/errors'
import { resolveProviderRuntime } from '../handlers/llm/providerRuntime'

it('explicit budget overrides static Max; an omitted override preserves Max', () => {
  setProvidersForTests({ $schemaVersion: 1, providers: [{ id: 'fixture', name: 'fixture', type: 'openai-chat', auth: { kind: 'apiKey', value: 'synthetic-key' }, baseUrl: 'https://example.invalid', models: [{ id: 'fixture-max', apiModel: 'gpt-6-luna', displayName: 'fixture', thinking: true, thinkingLevel: 'max' }] }, { id: 'gemini-fixture', name: 'fixture', type: 'gemini', auth: { kind: 'apiKey', value: 'synthetic-key' }, baseUrl: '', models: [{ id: 'fixture-budget', apiModel: 'gemini-3.1-pro-preview', displayName: 'fixture', thinking: true, thinkingLevel: 'max' }] }] })
  const runtime = resolveProviderRuntime('fixture-max')
  const defaultRequest = runtime.prepareStreamRequest([]).request
  expect(defaultRequest.thinkingLevel).toBe('max')
  expect(() => runtime.prepareStreamRequest([], [], undefined, undefined, { budget: 4096 })).toThrow('Thinking budget is not supported')
  const budget = resolveProviderRuntime('fixture-budget').prepareStreamRequest([], [], undefined, undefined, { budget: 4096 }).request
  expect(budget.thinkingBudgetTokens).toBe(4096)
  expect(budget.thinkingLevel).toBeUndefined()
  for (const level of ['low', 'medium', 'high', 'xhigh', 'max']) {
    const request = runtime.prepareStreamRequest([], [], undefined, undefined, { level }).request
    expect(request.thinkingLevel).toBe(level)
    expect(request.thinkingBudgetTokens).toBeUndefined()
  }
})

it.each(['max_tokens', 'content_filter'])('does not report %s as a successful turn', async (stopReason) => {
  const events = (async function* () {
    yield { type: 'done' as const, stopReason, usage: { inputTokens: 1, outputTokens: 1 } }
  })()
  await expect((async () => {
    for await (const _frame of translateStream(events)) { /* consume */ }
  })()).rejects.toThrow()
})

it('preserves actionable non-retryable Connect errors across provider error wrappers', async () => {
  const events = (async function* () {
    yield { type: 'done' as const, stopReason: 'max_tokens', usage: { inputTokens: 1, outputTokens: 1 } }
  })()
  try {
    for await (const _frame of translateStream(events)) { /* consume */ }
    throw new Error('Expected truncation error')
  }
  catch (error) {
    expect(makeProviderError(error)).toBe(error)
  }
})
