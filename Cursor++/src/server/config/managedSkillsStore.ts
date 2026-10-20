/**
 * managed-skills.json — 官方 GetManagedSkills 的本地缓存
 *
 * 流程:
 *   1. 透传客户端请求到官方（URL 由客户端原始请求头决定）
 *   2. 成功 → 缓存响应到内存(10min) + 持久化到 ~/.ccursor/managed-skills.json
 *   3. 失败 → 从 ~/.ccursor/managed-skills.json 读取
 *
 * 目的: 离线时仍能注入 skills（如 canvas/review 等），保持功能可用。
 */
import { logger } from '../logger'
import { accountCacheKey } from './accountKey'
import { readJsonOrNull, writeJsonAtomic } from './atomic'
import { getManagedSkillsFilePath } from './paths'

const OFFICIAL_BASE = 'https://api2.cursor.sh'
const ENDPOINT = '/aiserver.v1.DashboardService/GetManagedSkills'
const CACHE_TTL_MS = 10 * 60 * 1000

interface CacheEntry {
  key: string
  expiresAt: number
  data: Record<string, unknown>
}

let cache: CacheEntry | null = null

function buildForwardHeaders(clientHeaders: Headers): Record<string, string> {
  const out: Record<string, string> = {
    'content-type': 'application/json',
    'connect-protocol-version': '1',
  }
  for (const key of ['authorization', 'user-agent', 'accept-language']) {
    const v = clientHeaders.get(key)
    if (v)
      out[key] = v
  }
  clientHeaders.forEach((value, key) => {
    if (key.toLowerCase().startsWith('x-cursor-'))
      out[key] = value
  })
  return out
}

function loadLocal(key: string): Record<string, unknown> | null {
  const envelope = readJsonOrNull<{ accountKey: string, data: Record<string, unknown> }>(getManagedSkillsFilePath())
  return envelope?.accountKey === key ? envelope.data : null
}

function persistLocal(key: string, data: Record<string, unknown>): void {
  try {
    writeJsonAtomic(getManagedSkillsFilePath(), { schemaVersion: 1, accountKey: key, data })
  }
  catch (err) {
    logger.debug({ err: (err as Error).message }, '[SKILLS] persist to local failed (non-critical)')
  }
}

export async function fetchManagedSkills(
  clientHeaders: Headers,
): Promise<Record<string, unknown>> {
  const now = Date.now()
  const key = accountCacheKey(clientHeaders)
  if (cache?.key === key && cache.expiresAt > now)
    return cache.data

  try {
    const res = await fetch(`${OFFICIAL_BASE}${ENDPOINT}`, {
      method: 'POST',
      signal: AbortSignal.timeout(8000),
      headers: buildForwardHeaders(clientHeaders),
      body: '{}',
    })

    if (!res.ok) {
      logger.warn({ status: res.status }, '[SKILLS] upstream GetManagedSkills failed')
      return fallback(key)
    }

    const data = await res.json() as Record<string, unknown>
    cache = { key, expiresAt: now + CACHE_TTL_MS, data }
    const count = Array.isArray(data.skills) ? data.skills.length : 0
    logger.info({ count }, '[SKILLS] upstream GetManagedSkills fetched')
    persistLocal(key, data)
    return data
  }
  catch (err) {
    logger.warn({ err: (err as Error).message }, '[SKILLS] upstream GetManagedSkills error')
    return fallback(key)
  }
}

function fallback(key: string): Record<string, unknown> {
  if (cache?.key === key)
    return cache.data
  const local = loadLocal(key)
  if (local) {
    const count = Array.isArray((local as any).skills) ? (local as any).skills.length : 0
    cache = { key, expiresAt: Date.now() + CACHE_TTL_MS, data: local }
    logger.info({ count }, '[SKILLS] loaded managed skills from local cache')
    return local
  }
  return {}
}

export function resetManagedSkillsCacheForTests(): void {
  cache = null
}
