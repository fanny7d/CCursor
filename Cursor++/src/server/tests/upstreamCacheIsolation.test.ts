import { create } from '@bufbuild/protobuf'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { fetchManagedSkills, resetManagedSkillsCacheForTests } from '../config/managedSkillsStore'
import { AvailableModelsRequestSchema } from '../gen/aiserver_v1_pb'
import { fetchUpstreamAvailableModels, resetUpstreamCacheForTests } from '../handlers/models/upstream'

const accountA = new Headers({ authorization: 'Bearer synthetic-account-A' })
const accountB = new Headers({ authorization: 'Bearer synthetic-account-B' })
const fetchMock = vi.fn()

beforeEach(() => {
  resetUpstreamCacheForTests()
  resetManagedSkillsCacheForTests()
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

it('does not reuse another account model list on cache hit or upstream failure', async () => {
  const request = create(AvailableModelsRequestSchema)
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ models: [{ name: 'fixture-A' }] })))
  const a = await fetchUpstreamAvailableModels(accountA, request)
  expect(a?.models[0]?.name).toBe('fixture-A')
  expect(await fetchUpstreamAvailableModels(accountA, request)).toBe(a)
  expect(fetchMock).toHaveBeenCalledTimes(1)
  fetchMock.mockResolvedValueOnce(new Response('', { status: 401 }))
  expect(await fetchUpstreamAvailableModels(accountB, request)).toBeNull()
  expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)
})

it('does not reuse another account managed skills from memory or disk', async () => {
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ skills: [{ name: 'fixture-A' }] })))
  expect(await fetchManagedSkills(accountA)).toEqual({ skills: [{ name: 'fixture-A' }] })
  fetchMock.mockResolvedValueOnce(new Response('', { status: 401 }))
  expect(await fetchManagedSkills(accountB)).toEqual({})
  resetManagedSkillsCacheForTests()
  fetchMock.mockRejectedValueOnce(new Error('offline'))
  expect(await fetchManagedSkills(accountB)).toEqual({})
  fetchMock.mockRejectedValueOnce(new Error('offline'))
  expect(await fetchManagedSkills(accountA)).toEqual({ skills: [{ name: 'fixture-A' }] })
  expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)
})
