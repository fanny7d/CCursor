import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  constructAgent: vi.fn(),
  fetch: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
}))

vi.mock('undici', () => ({
  ProxyAgent: class {
    constructor(options: unknown) {
      mocks.constructAgent(options)
    }
  },
  fetch: mocks.fetch,
}))
vi.mock('node:child_process', () => ({ execSync: vi.fn(() => '') }))
vi.mock('../logger', () => ({ logger: { info: mocks.info, debug: mocks.debug } }))

beforeEach(() => {
  vi.clearAllMocks()
})

it('keeps proxy credentials for connections while removing them from diagnostic logs', async () => {
  const { createProxiedFetch } = await import('../handlers/llm/proxyFetch')
  const proxyUrl = 'https://proxy-user:synthetic-proxy-password@proxy.example:8443/private-path?token=synthetic-query-token#fragment'

  const fetch = createProxiedFetch(proxyUrl)
  await fetch('https://provider.example/v1/models')

  expect(mocks.constructAgent).toHaveBeenCalledWith(expect.objectContaining({ uri: proxyUrl }))
  expect(mocks.fetch).toHaveBeenCalledWith('https://provider.example/v1/models', expect.objectContaining({ dispatcher: expect.any(Object) }))
  expect(mocks.info).toHaveBeenCalledWith(
    expect.objectContaining({ proxyUrl: 'https://proxy.example:8443' }),
    '[PROXY] LLM fetch via proxy',
  )
  const logs = JSON.stringify(mocks.info.mock.calls)
  for (const secret of ['proxy-user', 'synthetic-proxy-password', 'private-path', 'synthetic-query-token', 'fragment']) {
    expect(logs).not.toContain(secret)
  }
})
