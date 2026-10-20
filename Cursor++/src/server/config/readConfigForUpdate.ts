import { lstatSync, readFileSync } from 'node:fs'

export function isConfigObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Only a genuinely absent file may be replaced with defaults during a save. */
export function readConfigForUpdate<T>(path: string, validate: (value: unknown) => value is T): T | null {
  const refused = () => new Error(`Cannot save ${path}: the existing configuration is unreadable or invalid. Repair the file before saving.`)
  let raw: string
  try {
    raw = readFileSync(path, 'utf-8')
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      try {
        // A dangling symlink also returns ENOENT when read; it is not a missing file.
        lstatSync(path)
      }
      catch (statError) {
        if ((statError as NodeJS.ErrnoException).code === 'ENOENT')
          return null
      }
    }
    throw refused()
  }
  let loaded: unknown
  try {
    loaded = JSON.parse(raw)
  }
  catch {
    // Do not include parser errors: they can contain fragments of API keys.
    throw refused()
  }
  if (!validate(loaded))
    throw refused()
  return loaded
}
