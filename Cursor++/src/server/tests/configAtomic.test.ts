import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readJsonOrNull, withSerial, writeJsonAtomic } from '../config/atomic'

let testDir: string

beforeEach(() => {
  testDir = mkdtempSync(join(tmpdir(), 'ccursor-atomic-'))
})

afterEach(() => {
  vi.restoreAllMocks()
  rmSync(testDir, { recursive: true, force: true })
})

describe('private atomic config writes', () => {
  it('does not log secret fragments from malformed JSON', () => {
    const path = join(testDir, 'providers.json')
    writeFileSync(path, 'synthetic-private-key-not-json')
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(readJsonOrNull(path)).toBeNull()
    expect(warning).toHaveBeenCalled()
    expect(JSON.stringify(warning.mock.calls)).not.toContain('synthetic-private-key-not-json')
  })

  it.skipIf(process.platform === 'win32')('keeps API-key files private after replacing an existing 0600 file', () => {
    const path = join(testDir, 'providers.json')
    writeFileSync(path, '{"providers":[]}', { mode: 0o600 })

    writeJsonAtomic(path, { providers: [{ auth: { value: 'synthetic-test-key' } }] })

    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual({ providers: [{ auth: { value: 'synthetic-test-key' } }] })
    expect(readdirSync(testDir)).toEqual(['providers.json'])
  })

  it.skipIf(process.platform === 'win32')('creates new config files and directories with private permissions', () => {
    const dir = join(testDir, 'config')
    const path = join(dir, 'web-tools.json')

    writeJsonAtomic(path, { apiKey: 'synthetic-test-key' })

    expect(statSync(dir).mode & 0o077).toBe(0)
    expect(statSync(path).mode & 0o077).toBe(0)
  })

  it('removes the temporary secret file when the atomic replacement fails', () => {
    const path = join(testDir, 'providers.json')
    mkdirSync(path)
    writeFileSync(join(path, 'existing'), 'keep this original directory')

    expect(() => writeJsonAtomic(path, { apiKey: 'synthetic-test-key' })).toThrow()
    expect(readdirSync(testDir)).toEqual(['providers.json'])
    expect(readFileSync(join(path, 'existing'), 'utf-8')).toBe('keep this original directory')
  })
})

describe('config mutation serialization', () => {
  it('runs a queued update after a failed update without overlapping either operation', async () => {
    const order: string[] = []
    let releaseFirst!: () => void
    const barrier = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    const first = withSerial('synthetic-config', async () => {
      order.push('first-start')
      await barrier
      order.push('first-fail')
      throw new Error('synthetic write failure')
    })
    const second = withSerial('synthetic-config', () => {
      order.push('second')
      return 'saved'
    })

    await Promise.resolve()
    expect(order).toEqual(['first-start'])
    releaseFirst()
    await expect(first).rejects.toThrow('synthetic write failure')
    await expect(second).resolves.toBe('saved')
    expect(order).toEqual(['first-start', 'first-fail', 'second'])
  })
})
