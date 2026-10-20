import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Set before any worker imports production modules, including global setup caches.
export default function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'ccursor-suite-'))
  process.env.CCURSOR_DATA_DIR = dir
  delete process.env.BYOK_AGENT_DB_PATH
  return () => rmSync(dir, { recursive: true, force: true })
}
