import { randomBytes } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getCcursorDir } from './paths'

export function readLocalAccessToken(): string {
  let token: unknown
  try {
    token = JSON.parse(readFileSync(join(getCcursorDir(), 'local-access.json'), 'utf8')).token
  }
  catch {
    throw new Error('Local access credential unavailable; restore local-access.json before starting Cursor++')
  }
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token))
    throw new Error('Invalid local access credential; restore local-access.json before starting Cursor++')
  return token
}

export function ensureLocalAccessToken(): string {
  mkdirSync(getCcursorDir(), { recursive: true, mode: 0o700 })
  try {
    writeFileSync(join(getCcursorDir(), 'local-access.json'), JSON.stringify({ token: randomBytes(32).toString('hex') }), { mode: 0o600, flag: 'wx' })
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
      throw error
  }
  return readLocalAccessToken()
}
