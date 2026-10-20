export type UpstreamOutcome = 'completed' | 'cancelled' | 'authentication' | 'quota' | 'rate_limit' | 'request' | 'timeout' | 'network' | 'unavailable' | 'unknown' | 'truncated' | 'filtered'

export function classifyUpstreamError(error: unknown): { category: UpstreamOutcome, retryable: boolean, status?: number } {
  const value = error as { name?: string, status?: number, code?: string, error?: { code?: string } } | null
  const status = typeof value?.status === 'number' ? value.status : undefined
  const code = value?.code ?? value?.error?.code
  if (value?.name === 'AbortError' || value?.name === 'APIUserAbortError')
    return { category: 'cancelled', retryable: false }
  if (status === 401 || status === 403)
    return { category: 'authentication', retryable: false, status }
  if (status === 402 || code === 'insufficient_quota')
    return { category: 'quota', retryable: false, status }
  if (status === 429)
    return { category: 'rate_limit', retryable: true, status }
  if (status !== undefined && status >= 400 && status < 500)
    return { category: 'request', retryable: false, status }
  if (value?.name?.includes('Timeout') || code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT')
    return { category: 'timeout', retryable: true, status }
  if (status !== undefined && status >= 500)
    return { category: 'unavailable', retryable: true, status }
  if (code === 'ECONNRESET' || code === 'ECONNREFUSED' || value?.name === 'APIConnectionError')
    return { category: 'network', retryable: true }
  return { category: 'unknown', retryable: true, status }
}

const counters: Record<UpstreamOutcome, number> = { completed: 0, cancelled: 0, authentication: 0, quota: 0, rate_limit: 0, request: 0, timeout: 0, network: 0, unavailable: 0, unknown: 0, truncated: 0, filtered: 0 }

export function recordUpstreamOutcome(outcome: UpstreamOutcome): void {
  counters[outcome]++
}

/** Fixed categories and counts only; no prompts, URLs, IDs, headers or errors. */
export function upstreamDiagnostics() {
  return { outcomes: { ...counters } }
}
