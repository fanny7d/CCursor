import type { LLMTool } from '../../../llm/types'
import { toProtoValueMap } from '../../protoValue'
import type { ToolRegistryEntry } from '../types'

export const CALCULATE_TOOL: LLMTool = {
  name: 'Calculate',
  description: 'Compute exact arithmetic locally, without Shell, filesystem, network, or code execution. Use this for numeric results instead of mental arithmetic. Supply plain decimal operands as strings when precision matters; expressions such as "7 * 0.07" are not operands. For dependent calculations, wait for the earlier tool result before using it in a later call. Operations apply left-to-right. The result is an exact decimal string, or a fraction for repeating decimals.',
  inputSchema: {
    type: 'object',
    properties: {
      operation: { type: 'string', enum: ['sum', 'subtract', 'multiply', 'divide'] },
      operands: { type: 'array', minItems: 1, maxItems: 100, items: { anyOf: [{ type: 'number' }, { type: 'string', maxLength: 80, pattern: '^-?\\d+(?:\\.\\d{1,30})?$' }] } },
    },
    required: ['operation', 'operands'],
    additionalProperties: false,
  },
}

interface Fraction { numerator: bigint, denominator: bigint }

function gcd(left: bigint, right: bigint): bigint {
  left = left < 0n ? -left : left
  right = right < 0n ? -right : right
  while (right) [left, right] = [right, left % right]
  return left
}

function reduce(numerator: bigint, denominator: bigint): Fraction {
  if (denominator === 0n) throw new Error('Division by zero')
  if (denominator < 0n) { numerator = -numerator; denominator = -denominator }
  if (numerator.toString().length > 1000 || denominator.toString().length > 1000)
    throw new Error('Arithmetic result exceeds the size limit')
  const divisor = gcd(numerator, denominator)
  return { numerator: numerator / divisor, denominator: denominator / divisor }
}

function parseOperand(value: unknown): Fraction {
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error('Operands must be decimal numbers or strings')
  if (typeof value === 'number' && (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))))
    throw new Error('Use decimal strings for large integers; numbers must be finite and safe')
  const text = String(value)
  if (text.length > 80 || !/^-?\d+(?:\.\d{1,30})?$/.test(text))
    throw new Error('Use plain decimal notation, at most 80 characters and 30 decimal places')
  const decimals = text.split('.')[1]?.length ?? 0
  return reduce(BigInt(text.replace('.', '')), 10n ** BigInt(decimals))
}

function format(value: Fraction): string {
  let remainder = value.denominator
  let twos = 0; let fives = 0
  while (remainder % 2n === 0n) { remainder /= 2n; twos++ }
  while (remainder % 5n === 0n) { remainder /= 5n; fives++ }
  if (remainder !== 1n) return `${value.numerator}/${value.denominator}`
  const scale = Math.max(twos, fives)
  if (scale > 1000) throw new Error('Arithmetic result exceeds the precision limit')
  const scaled = value.numerator * (10n ** BigInt(scale)) / value.denominator
  const sign = scaled < 0n ? '-' : ''
  const digits = (scaled < 0n ? -scaled : scaled).toString().padStart(scale + 1, '0')
  if (!scale) return sign + digits
  return sign + `${digits.slice(0, -scale)}.${digits.slice(-scale)}`.replace(/\.?0+$/, '')
}

export function calculate(input: Record<string, unknown>): { result: string, exact: true } {
  const operation = input.operation
  if (typeof operation !== 'string' || !['sum', 'subtract', 'multiply', 'divide'].includes(operation)) throw new Error('Unsupported arithmetic operation')
  if (!Array.isArray(input.operands) || input.operands.length < 1 || input.operands.length > 100)
    throw new Error('Supply between 1 and 100 operands')
  const operands = input.operands.map(parseOperand)
  let result = operands[0]
  for (const operand of operands.slice(1)) {
    switch (operation) {
      case 'sum': result = reduce(result.numerator * operand.denominator + operand.numerator * result.denominator, result.denominator * operand.denominator); break
      case 'subtract': result = reduce(result.numerator * operand.denominator - operand.numerator * result.denominator, result.denominator * operand.denominator); break
      case 'multiply': result = reduce(result.numerator * operand.numerator, result.denominator * operand.denominator); break
      case 'divide': result = reduce(result.numerator * operand.denominator, result.denominator * operand.numerator); break
    }
  }
  return { result: format(result), exact: true }
}

export const CalculateTool: ToolRegistryEntry = {
  canonicalName: 'Calculate',
  aliases: ['Calculate'],
  // Reuse Cursor's tool-result display envelope. This is local arithmetic,
  // not an external MCP server, and never sends an exec message to the client.
  cursorToolType: 'mcpToolCall',
  execArgsType: null,
  llmToolByProvider: {}, // Opted in by the Grok Responses profile only.
  buildStartedArgs: (input, callId) => ({
    name: 'Calculate', args: toProtoValueMap(input), toolCallId: callId,
    providerIdentifier: 'cursor-plus-local', serverIdentifier: 'cursor-plus-local', toolName: 'Calculate',
  }),
}
