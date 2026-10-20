import { classifyUpstreamError, recordUpstreamOutcome } from '../../upstreamDiagnostics'
import type { LLMProvider, LLMStreamEvent, LLMStreamRequest } from './types'

/** Cancellation interrupts a pending next(), not just the next delivered token. */
export function streamWithCancellation(provider: LLMProvider, request: LLMStreamRequest): AsyncGenerator<LLMStreamEvent> {
  const controller = new AbortController()
  const abort = () => controller.abort(request.signal?.reason)
  request.signal?.addEventListener('abort', abort, { once: true })
  if (request.signal?.aborted)
    abort()
  let rejectAbort!: (reason: unknown) => void
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject })
  // Always observe rejection, including abort after a consumer breaks at yield.
  void aborted.catch(() => {})
  const onAbort = () => rejectAbort(controller.signal.reason ?? new DOMException('Cancelled', 'AbortError'))
  controller.signal.addEventListener('abort', onAbort, { once: true })
  let outcomeRecorded = false
  const detach = () => request.signal?.removeEventListener('abort', abort)
  async function* run(): AsyncGenerator<LLMStreamEvent> {
    let iterator: AsyncIterator<LLMStreamEvent> | undefined
    try {
      controller.signal.throwIfAborted()
      iterator = provider.stream({ ...request, signal: controller.signal })[Symbol.asyncIterator]()
      while (true) {
        const next = await Promise.race([iterator.next(), aborted])
        controller.signal.throwIfAborted()
        if (next.done)
          return
        if (next.value.type === 'done') {
          recordUpstreamOutcome(next.value.stopReason === 'max_tokens' ? 'truncated' : next.value.stopReason === 'content_filter' ? 'filtered' : 'completed')
          outcomeRecorded = true
        }
        yield next.value
      }
    }
    catch (error) {
      if (!outcomeRecorded) {
        recordUpstreamOutcome(classifyUpstreamError(error).category)
        outcomeRecorded = true
      }
      throw error
    }
    finally {
      if (!outcomeRecorded) recordUpstreamOutcome(controller.signal.aborted ? 'cancelled' : 'completed')
      controller.abort(new DOMException('Stream closed', 'AbortError'))
      detach()
      controller.signal.removeEventListener('abort', onAbort)
      // A broken provider may never settle next(). Never block closing our stream.
      if (iterator?.return)
        void Promise.resolve(iterator.return()).catch(() => {})
    }
  }
  const generator = run()
  return {
    next: value => generator.next(value),
    return: value => {
      detach()
      controller.abort(new DOMException('Stream closed', 'AbortError'))
      return generator.return(value)
    },
    throw: error => {
      controller.abort(error)
      return generator.throw(error)
    },
    [Symbol.asyncIterator]() { return this },
  }
}
