import { afterEach, expect, it, vi } from 'vitest'
import { startUpdateCheck, stopUpdateCheck } from '../../update-check'

afterEach(() => {
  stopUpdateCheck()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

it('directs development builds to their own manual update guide without upstream npm requests', async () => {
  vi.useFakeTimers()
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  const log = vi.fn()
  const state = { get: vi.fn(), update: vi.fn(), keys: vi.fn() }

  startUpdateCheck(state, log)
  await vi.advanceTimersByTimeAsync(5 * 60 * 60 * 1000)

  expect(log).toHaveBeenCalledWith(expect.stringContaining('https://github.com/fanny7d/CCursor/'))
  expect(log.mock.calls.flat().join(' ')).not.toContain('npx @cometix/ccursor')
  expect(fetch).not.toHaveBeenCalled()
  expect(vi.getTimerCount()).toBe(0)
})
