import { expect, it } from 'vitest'
import { classifyUpstreamError, recordUpstreamOutcome, upstreamDiagnostics } from '../upstreamDiagnostics'

it.each([
  [{ status: 401 }, 'authentication', false],
  [{ status: 403 }, 'authentication', false],
  [{ status: 402 }, 'quota', false],
  [{ status: 429, code: 'insufficient_quota' }, 'quota', false],
  [{ status: 429 }, 'rate_limit', true],
  [{ status: 400 }, 'request', false],
  [{ status: 503 }, 'unavailable', true],
  [{ name: 'TimeoutError' }, 'timeout', true],
  [{ code: 'ECONNRESET' }, 'network', true],
  [{ name: 'AbortError' }, 'cancelled', false],
] as const)('classifies upstream failure without inferring from raw secret messages: %j', (error, category, retryable) => {
  expect(classifyUpstreamError({ ...error, message: 'synthetic-private-error' })).toMatchObject({ category, retryable })
})

it('diagnostics contain only fixed categories and numeric counts', () => {
  const before = upstreamDiagnostics().outcomes.completed
  recordUpstreamOutcome('completed')
  expect(upstreamDiagnostics().outcomes.completed).toBe(before + 1)
  for (const value of Object.values(upstreamDiagnostics().outcomes))
    expect(Number.isSafeInteger(value)).toBe(true)
})
