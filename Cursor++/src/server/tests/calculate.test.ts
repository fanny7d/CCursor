import type { AgentServerMessage } from '../gen/agent_v1_pb'
import type { LLMMessage, LLMToolResultBlock } from '../handlers/llm/types'
import { toJsonString } from '@bufbuild/protobuf'
import { expect, it } from 'vitest'
import { loadProviders, setProvidersForTests } from '../config/providersStore'
import { AgentServerMessageSchema } from '../gen/agent_v1_pb'
import { partitionCursorBuiltinTools } from '../handlers/agent/dynamicTools'
import { createEphemeralSession } from '../handlers/agent/session'
import { calculate } from '../handlers/agent/toolkit/definitions/Calculate'
import { runToolCall } from '../handlers/agent/toolRuntime'
import { resolveProviderRuntime } from '../handlers/llm/providerRuntime'
import { openAIStateStrategy } from '../handlers/llm/stateStrategy'

const baseline = loadProviders()
setProvidersForTests({ ...baseline, providers: [...baseline.providers, {
  id: 'grok-response-tests',
  name: 'synthetic',
  baseUrl: '',
  type: 'openai-responses',
  auth: { kind: 'apiKey', value: 'synthetic-only' },
  models: [{ id: 'grok-response-tests', apiModel: 'grok-4.7', displayName: 'synthetic', thinking: true }],
}, {
  id: 'grok-message-tests',
  name: 'synthetic',
  baseUrl: '',
  type: 'anthropic',
  auth: { kind: 'apiKey', value: 'synthetic-only' },
  models: [{ id: 'grok-message-tests', apiModel: 'grok-4.7', displayName: 'synthetic', thinking: true }],
}] })

it.each([
  ['sum', [156, 48, 72, 99, 101], '476'],
  ['sum', ['0.1', '0.2'], '0.3'],
  ['sum', ['9007199254740993', '-1'], '9007199254740992'],
  ['subtract', ['1', '1.001'], '-0.001'],
  ['multiply', ['-1.25', '0.8'], '-1'],
  ['divide', ['1', '8'], '0.125'],
  ['divide', ['1', '3'], '1/3'],
  ['sum', ['-0.00', '0'], '0'],
])('calculates exact %s of %j', (operation, operands, result) => {
  expect(calculate({ operation, operands })).toEqual({ result, exact: true })
})

it.each([
  { operation: 'eval', operands: ['1'] },
  { operation: ['sum'], operands: ['1', '2'] },
  { operation: 'sum', operands: [] },
  { operation: 'sum', operands: Array.from({ length: 101 }).fill(1) },
  { operation: 'sum', operands: ['process.exit()'] },
  { operation: 'sum', operands: ['1e10000'] },
  { operation: 'sum', operands: [Number.POSITIVE_INFINITY] },
  { operation: 'sum', operands: [9007199254740992] },
  { operation: 'divide', operands: [1, 0] },
  { operation: 'multiply', operands: Array.from({ length: 20 }, () => '9'.repeat(80)) },
])('rejects unsafe, invalid or excessive arithmetic %#', (input) => {
  expect(() => calculate(input)).toThrow()
})

it('isolates Grok tools and prompt from Responses transport and existing Messages/GPT profiles', () => {
  const grok = resolveProviderRuntime('grok-response-tests')
  expect(grok.provider.name).toBe('openai-responses')
  expect(grok.stateStrategy).toBe(openAIStateStrategy)
  expect(grok.promptProfile.systemPromptStyle).toBe('anthropic-main')
  const tools = grok.listRuntimeTools()
  expect(tools.map(t => t.name)).toEqual(expect.arrayContaining(['Read', 'Write', 'Calculate']))
  expect(tools.map(t => t.name)).not.toContain('ApplyPatch')
  const final = partitionCursorBuiltinTools(tools, true)
  expect(final.staticTools.map(t => t.name)).toContain('Calculate')
  expect(resolveProviderRuntime('grok-message-tests').listRuntimeTools().map(t => t.name)).not.toContain('Calculate')
  const gpt = resolveProviderRuntime('gpt-5.4-medium')
  expect(gpt.promptProfile.systemPromptStyle).toBe('openai-main')
  expect(gpt.listRuntimeTools().map(t => t.name)).not.toContain('Calculate')
})

it.each(['grok-response-tests', 'grok-message-tests', 'gpt-5.4-medium'])('runs calculator locally or rejects unavailable profile without any client exec: %s', async (modelId) => {
  const messages: LLMMessage[] = []
  const pendingToolResults: LLMToolResultBlock[] = []
  const roundContext = {
    pendingToolResults,
    createToolResult: openAIStateStrategy.createToolResult.bind(openAIStateStrategy),
    recordToolResult(transcript: LLMMessage[], result: LLMToolResultBlock) { openAIStateStrategy.addToolResult(transcript, pendingToolResults, result) },
  }
  const frames: AgentServerMessage[] = []
  for await (const frame of runToolCall({
    toolCall: { callId: 'calculate-1', name: 'Calculate', input: { operation: 'sum', operands: [156, 48, 72, 99, 101] } },
    availableMcpTools: [],
    conversationId: 'calculate-test',
    currentModelId: modelId,
    round: 0,
    session: createEphemeralSession('calculate-test'),
    roundContext,
    messages,
    allocateExecMessageId: () => 1,
    allocateInteractionId: () => 1,
  })) {
    expect(frame.message.case).not.toBe('execServerMessage')
    expect(() => toJsonString(AgentServerMessageSchema, frame)).not.toThrow()
    frames.push(frame)
  }
  expect(frames).toHaveLength(2)
  expect(pendingToolResults).toHaveLength(1)
  if (modelId === 'grok-response-tests') {
    expect(pendingToolResults[0].isError).not.toBe(true)
    expect(pendingToolResults[0].content).toContain('476')
  }
  else {
    expect(pendingToolResults[0].isError).toBe(true)
    expect(pendingToolResults[0].content).toContain('not available')
  }
})
