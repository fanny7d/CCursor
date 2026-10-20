import { createHash } from 'node:crypto'

/** Cache scopes never retain bearer credentials in their serialized keys. */
export function accountCacheKey(headers: Headers): string {
  const identity: Array<[string, string]> = []
  headers.forEach((value, name) => {
    if (name === 'authorization' || name.startsWith('x-cursor-'))
      identity.push([name, value])
  })
  identity.sort(([a], [b]) => a.localeCompare(b))
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex')
}
