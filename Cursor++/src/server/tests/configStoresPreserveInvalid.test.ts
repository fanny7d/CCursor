import type { ProvidersConfig } from '../data/defaults'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_PROVIDERS, DEFAULT_ROUTES } from '../data/defaults'

let testDir: string
let providersStore: typeof import('../config/providersStore')
let routesStore: typeof import('../config/routesStore')
const readFailure = vi.hoisted(() => ({ path: undefined as string | undefined }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    readFileSync: ((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      if (file === readFailure.path)
        throw Object.assign(new Error('synthetic permission failure'), { code: 'EACCES' })
      return (actual.readFileSync as (...params: unknown[]) => unknown)(file, ...args)
    }) as typeof fs.readFileSync,
  }
})
vi.mock('../config/paths', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/paths')>()
  return {
    ...actual,
    getProvidersFilePath: () => join(testDir, 'providers.json'),
    getRoutesFilePath: () => join(testDir, 'routes.json'),
  }
})

beforeEach(async () => {
  testDir = fs.mkdtempSync(join(tmpdir(), 'ccursor-preserve-config-'))
  readFailure.path = undefined
  // Global setup preloads providersStore; reload after applying the isolated paths.
  vi.resetModules()
  const paths = await import('../config/paths')
  // Refuse to exercise a mutator unless both destinations are inside this fixture.
  expect(paths.getProvidersFilePath()).toBe(join(testDir, 'providers.json'))
  expect(paths.getRoutesFilePath()).toBe(join(testDir, 'routes.json'))
  providersStore = await import('../config/providersStore')
  routesStore = await import('../config/routesStore')
})

afterEach(() => {
  vi.restoreAllMocks()
  readFailure.path = undefined
  providersStore?.resetProvidersCacheForTests()
  fs.rmSync(testDir, { recursive: true, force: true })
})

const stores = [
  { name: 'providers', ensure: () => providersStore.ensureProvidersFile(), update: () => providersStore.updateProviders(() => {}), defaults: DEFAULT_PROVIDERS },
  { name: 'routes', ensure: () => routesStore.ensureRoutesFile(), update: () => routesStore.updateRoutes(() => {}), defaults: DEFAULT_ROUTES },
] as const

describe.each(stores)('$name config preservation', ({ name, ensure, update, defaults }) => {
  it.each(['{"synthetic-secret":', 'null', '[]', '"invalid-config"'])('preserves malformed or invalid existing bytes: %s', async (raw) => {
    const path = join(testDir, `${name}.json`)
    fs.writeFileSync(path, raw)

    await expect(ensure()).resolves.toEqual(defaults)
    await expect(update()).rejects.toThrow('the existing configuration is unreadable or invalid')
    expect(fs.readFileSync(path, 'utf-8')).toBe(raw)
    expect(fs.readdirSync(testDir)).toEqual([`${name}.json`])
  })

  it('refuses to save an unreadable existing file', async () => {
    const path = join(testDir, `${name}.json`)
    const raw = JSON.stringify(defaults)
    fs.writeFileSync(path, raw)
    readFailure.path = path

    await expect(ensure()).resolves.toEqual(defaults)
    await expect(update()).rejects.toThrow('the existing configuration is unreadable or invalid')
    readFailure.path = undefined
    expect(fs.readFileSync(path, 'utf-8')).toBe(raw)
  })

  it('initializes a genuinely missing file', async () => {
    await expect(ensure()).resolves.toEqual(defaults)
    expect(JSON.parse(fs.readFileSync(join(testDir, `${name}.json`), 'utf-8'))).toEqual(defaults)
  })

  it('can save directly when the config is genuinely missing', async () => {
    await expect(update()).resolves.toEqual(defaults)
    expect(JSON.parse(fs.readFileSync(join(testDir, `${name}.json`), 'utf-8'))).toEqual(defaults)
  })
})

it.each(['{}', '{"providers":{}}', '{"providers":[null]}', '{"providers":[{"models":{}}]}'])('does not replace a structurally invalid providers document: %s', async (raw) => {
  const path = join(testDir, 'providers.json')
  fs.writeFileSync(path, raw)
  const updater = vi.fn()

  await expect(providersStore.updateProviders(updater)).rejects.toThrow('the existing configuration is unreadable or invalid')
  expect(updater).not.toHaveBeenCalled()
  expect(fs.readFileSync(path, 'utf-8')).toBe(raw)
})

it.each(['{"server":null}', '{"collector":[]}', '{"redirect":{}}'])('does not replace an invalid routes structure: %s', async (raw) => {
  const path = join(testDir, 'routes.json')
  fs.writeFileSync(path, raw)

  await expect(routesStore.ensureRoutesFile()).resolves.toEqual(DEFAULT_ROUTES)
  await expect(routesStore.updateRoutes(() => {})).rejects.toThrow('the existing configuration is unreadable or invalid')
  expect(fs.readFileSync(path, 'utf-8')).toBe(raw)
})

it('preserves valid partial route settings while filling missing defaults', async () => {
  const path = join(testDir, 'routes.json')
  fs.writeFileSync(path, JSON.stringify({ byokMode: 'off', server: { port: 41000 }, redirect: ['custom/route'] }))

  const initialized = await routesStore.ensureRoutesFile()
  expect(initialized).toMatchObject({ byokMode: 0, server: { host: DEFAULT_ROUTES.server.host, port: 41000 }, redirect: ['custom/route'] })
  const updated = await routesStore.updateRoutes((draft) => {
    draft.collector.port = 41001
  })
  expect(updated).toMatchObject({ byokMode: 0, server: { port: 41000 }, collector: { port: 41001 }, redirect: ['custom/route'] })
})

it('preserves a valid NAS and Max provider config during a save', async () => {
  const path = join(testDir, 'providers.json')
  const config: ProvidersConfig = {
    $schemaVersion: 1,
    providers: [{
      id: 'test-nas',
      name: 'NAS',
      type: 'openai-chat',
      baseUrl: 'https://nas.example.com/cursor/v1',
      auth: { kind: 'apiKey', value: 'synthetic-test-key' },
      headers: { 'User-Agent': 'CursorPlus-Test' },
      models: [{ id: 'nas-model', apiModel: 'gpt-6-luna', displayName: 'NAS model', thinking: true, thinkingLevel: 'max', parameters: { effort: ['low', 'medium', 'high', 'xhigh', 'max'] } }],
    }],
  }
  fs.writeFileSync(path, JSON.stringify(config))

  await expect(providersStore.ensureProvidersFile()).resolves.toEqual(config)
  await expect(providersStore.updateProviders(() => {})).resolves.toEqual(config)
  expect(JSON.parse(fs.readFileSync(path, 'utf-8'))).toEqual(config)
})

it.skipIf(process.platform === 'win32')('preserves a dangling config symlink instead of treating it as a missing file', async () => {
  const path = join(testDir, 'providers.json')
  const target = join(testDir, 'missing-target.json')
  fs.symlinkSync(target, path)

  await expect(providersStore.updateProviders(() => {})).rejects.toThrow('the existing configuration is unreadable or invalid')
  expect(fs.lstatSync(path).isSymbolicLink()).toBe(true)
  expect(fs.readlinkSync(path)).toBe(target)
  expect(fs.existsSync(target)).toBe(false)
})
