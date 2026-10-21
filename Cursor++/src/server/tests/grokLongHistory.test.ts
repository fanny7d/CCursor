import type { HistoryEntry } from '../handlers/agent/historyManager'
import type { LLMMessage } from '../handlers/llm/types'
import { expect, it } from 'vitest'
import { planCompaction } from '../handlers/agent/compactionStrategy'
import { repairHistoryEntries } from '../handlers/agent/historyManager'
import { encodeResponsesInput } from '../handlers/llm/conversationCodec'
import { transformMessages } from '../handlers/llm/transformMessages'

function longHistory(): LLMMessage[] {
  const messages: LLMMessage[] = [
    { role: 'system', content: 'synthetic Grok Responses tool lifecycle' },
    { role: 'user', content: '<user_info>synthetic workspace</user_info>' },
  ]
  for (let round = 0; round < 120; round++) {
    messages.push({ role: 'user', content: `job ${round}: read, calculate, edit and verify` })
    const calls = ['Read', 'Read', 'Read', 'Calculate', 'Edit', 'Read'].map((name, index) => ({
      type: 'tool_use' as const,
      id: `call-${round}-${index}`,
      name,
      input: name === 'Calculate'
        ? { operation: 'divide', operands: ['1', round % 9 === 0 ? '0' : '8'] }
        : name === 'Edit'
          ? { path: `订单 ${round}.json`, old_string: 'pending', new_string: 'done' }
          : { path: `订单 ${round}-${index}.json` },
    }))
    messages.push({ role: 'assistant', content: [{
      type: 'thinking',
      text: '',
      sourceModel: 'openai-responses:grok-4.7',
      signature: JSON.stringify({
        type: 'reasoning',
        id: `rs_${round}`,
        encrypted_content: `synthetic-${round}`,
        summary: [],
      }),
    }, ...calls] })
    for (const call of calls) {
      messages.push({
        role: 'tool',
        toolCallId: call.id,
        toolName: call.name,
        content: call.name === 'Calculate'
          ? round % 9 === 0 ? 'Error: Division by zero' : '{"result":"0.125","exact":true}'
          : `{"round":${round},"sentinel":"中文🙂\\\"quoted\\\""}`,
        ...(call.name === 'Calculate' && round % 9 === 0 ? { isError: true } : {}),
      })
    }
    messages.push({ role: 'assistant', content: `job ${round} recorded` })
  }
  return messages
}

function assertPaired(messages: LLMMessage[]) {
  const transformed = transformMessages(messages, 'openai-responses', undefined, 'grok-4.7')
  const encoded = encodeResponsesInput(transformed)
  expect(JSON.stringify(encoded)).not.toContain('previous unsupported tool call')
  const calls = encoded.items.filter(item => 'type' in item && item.type === 'function_call')
  const outputs = encoded.items.filter(item => 'type' in item && item.type === 'function_call_output')
  const callIds = calls.map(item => 'call_id' in item ? item.call_id : '')
  const outputIds = outputs.map(item => 'call_id' in item ? item.call_id : '')
  expect(new Set(callIds).size).toBe(callIds.length)
  expect(callIds).toEqual(outputIds)
  return { encoded, calls, outputs }
}

it('preserves 720 mixed Grok calls, batched results, error results, unicode and encrypted reasoning through long Responses history', () => {
  const { encoded, calls, outputs } = assertPaired(longHistory())
  expect(calls).toHaveLength(720)
  expect(outputs).toHaveLength(720)
  expect(JSON.stringify(encoded)).toContain('Division by zero')
  expect(JSON.stringify(encoded)).toContain('中文🙂')
  const reasoning = encoded.items.filter(item => 'type' in item && item.type === 'reasoning')
  expect(reasoning).toHaveLength(120)
  expect(JSON.stringify(reasoning.at(-1))).toContain('synthetic-119')
})

it('keeps complete Grok call/result groups after compaction and a simulated restart rehydration', () => {
  const history = longHistory()
  const entries: HistoryEntry[] = history.map((message, index) => ({
    blobId: `synthetic-${index}`,
    raw: { role: message.role, content: message.content },
    message,
  }))
  const plan = planCompaction(repairHistoryEntries(entries))
  expect(plan.summarizeEntries.length).toBeGreaterThan(900)
  expect(plan.keepTail.length).toBeGreaterThan(0)
  const compacted = [
    ...plan.leading.map(entry => entry.message),
    { role: 'assistant' as const, content: 'Previous conversation summary: completed synthetic jobs' },
    ...plan.keepTail.map(entry => entry.message),
  ]
  const rehydrated = JSON.parse(JSON.stringify(compacted)) as LLMMessage[]
  const { calls } = assertPaired(rehydrated)
  expect(calls.length).toBeGreaterThan(0)
  expect(calls.length).toBeLessThan(720)
  expect(JSON.stringify(calls)).toContain('订单 119')
})

it('repairs an interrupted batched Grok turn without losing completed results or duplicating calls', () => {
  const history = longHistory()
  history.push({ role: 'assistant', content: [
    { type: 'tool_use', id: 'interrupted-read', name: 'Read', input: { path: 'fresh.json' } },
    { type: 'tool_use', id: 'interrupted-calc', name: 'Calculate', input: { operation: 'sum', operands: ['1', '2'] } },
  ] })
  history.push({ role: 'tool', toolCallId: 'interrupted-read', toolName: 'Read', content: 'actual completed read' })
  history.push({ role: 'user', content: 'Continue after cancellation and restart' })
  const { encoded, calls } = assertPaired(history)
  expect(calls).toHaveLength(722)
  expect(JSON.stringify(encoded)).toContain('actual completed read')
  expect(JSON.stringify(encoded)).toContain('interrupted-calc')
})
