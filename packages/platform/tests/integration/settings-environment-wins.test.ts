import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  anthropicBlock,
  cleanups,
  newSecretsKey,
  openReader,
  openStore,
  putSetting,
  SECRETS_KEY,
  setEnv,
  settingsConfig,
  settingsField,
  startStub,
  storedSettings,
  type ApiClient,
  type RowReader,
  type Store,
} from '../support/settings.js'

// AC-5 on SQLite: a field set by the environment or the config is listed with that source and no secret value, and a
// PUT to it answers 409 `settings.set_by_environment` and writes no row, while a field set nowhere takes a PUT. A
// token without the admin role gets 403 from GET, PUT and DELETE and changes no row.

const ENV_API_KEY = `sk-ant-settings-from-env-${randomUUID()}`
const CONFIG_SMTP_PASS = `smtp-pass-settings-from-config-${randomUUID()}`

const scope = cleanups()
let store: Store
let admin: ApiClient
let raw: RowReader
let baseUrl = ''

beforeAll(async () => {
  scope.add(setEnv({ [SECRETS_KEY]: newSecretsKey(), ANTHROPIC_API_KEY: ENV_API_KEY }))
  const stub = await startStub('anthropic')
  scope.add(() => stub.close())
  baseUrl = stub.url
  const dir = mkdtempSync(join(tmpdir(), 'settings-env-wins-'))
  scope.add(() => rmSync(dir, { recursive: true, force: true }))
  const target = join(dir, 'store.sqlite')
  store = await openStore({
    dialect: 'sqlite',
    target,
    config: settingsConfig('sqlite', {
      ai: anthropicBlock(stub),
      email: {
        provider: 'smtp',
        config: { smtp: { host: '127.0.0.1', port: 2525, pass: CONFIG_SMTP_PASS } },
      },
    }),
  })
  scope.add(() => store.stop())
  admin = await store.admin()
  raw = openReader('sqlite', target)
  scope.add(() => raw.close())
}, 60_000)

afterAll(() => scope.run())

const rowCount = async (): Promise<number> => (await storedSettings(raw)).length

describe('AC-5: the environment wins in the API', () => {
  it("AC-5: fields set by env and config list source 'env' and 'config', state set; a secret carries no value and appears nowhere in the body", async () => {
    const listing = await admin.call('GET', '/api/admin/settings')
    expect(listing.status, JSON.stringify(listing.body)).toBe(200)
    const field = (slot: string, path: string) => settingsField(listing.body.data, slot, path)
    const view = (slot: string, path: string) => [
      field(slot, path)?.source ?? null,
      field(slot, path)?.state,
    ]
    expect(view('ai', 'apiKey')).toEqual(['env', 'set'])
    expect(view('ai', 'baseUrl')).toEqual(['config', 'set'])
    expect(view('email', 'smtp.pass')).toEqual(['config', 'set'])
    expect(view('email', 'smtp.user')).toEqual([null, 'unset'])
    expect(field('ai', 'apiKey')).not.toHaveProperty('value')
    expect(field('email', 'smtp.pass')).not.toHaveProperty('value')
    expect(field('ai', 'baseUrl')?.value).toBe(baseUrl)
    const text = JSON.stringify(listing.body)
    expect(text).not.toContain(ENV_API_KEY)
    expect(text).not.toContain(CONFIG_SMTP_PASS)
  })

  it.each([
    ['ai', 'apiKey', 'env'],
    ['ai', 'baseUrl', 'config'],
    ['email', 'smtp.pass', 'config'],
  ])(
    'AC-5: a PUT to %s.%s (set by %s) answers 409 settings.set_by_environment and writes no row',
    async (slot, path) => {
      const before = await rowCount()
      const res = await putSetting(admin, slot, path, `settings-override-${randomUUID()}`)
      expect(res.status, JSON.stringify(res.body)).toBe(409)
      expect(res.body.error?.code).toBe('settings.set_by_environment')
      expect(before).toBe(await rowCount())
    },
  )

  it('AC-5: a PUT to the field nothing sets (email smtp.user) writes exactly one row, so the 409s are about the source', async () => {
    const before = await rowCount()
    const res = await putSetting(admin, 'email', 'smtp.user', `shop-${randomUUID()}`)
    expect(res.status, JSON.stringify(res.body)).toBe(200)
    expect(await rowCount()).toBe(before + 1)
  })

  it('AC-5: a token without the admin role gets 403 from GET, PUT and DELETE, and changes no row', async () => {
    const customer = await store.member(['customer'])
    const listed = await customer.call('GET', '/api/admin/settings')
    expect(listed.status, JSON.stringify(listed.body)).toBe(403)
    const before = await storedSettings(raw)
    const writes = [
      await putSetting(customer, 'email', 'smtp.user', `shop-${randomUUID()}`),
      await customer.call('DELETE', `/api/admin/settings/email/${encodeURIComponent('smtp.user')}`),
    ]
    expect(writes.map((a) => a.status)).toEqual([403, 403])
    expect(before).toEqual(await storedSettings(raw))
  })

  it.each([
    ['ai', 'notDeclared'],
    ['email', 'smtp.host'],
    ['no-such-slot', 'apiKey'],
  ])(
    'AC-5: a PUT to undeclared %s.%s answers 404 settings.unknown_field and writes no row',
    async (slot, path) => {
      const res = await putSetting(admin, slot, path, `settings-undeclared-${randomUUID()}`)
      expect(res.status, JSON.stringify(res.body)).toBe(404)
      expect(res.body.error?.code).toBe('settings.unknown_field')
      const rows = await storedSettings(raw)
      expect(rows.filter((r) => r.slot === slot && r.path === path)).toEqual([])
    },
  )

  it('AC-5: with NYMBAL_SECRETS_KEY unset, a PUT of a secret answers 503 settings.key_missing and writes no row', async () => {
    const local = cleanups()
    try {
      local.add(setEnv({ [SECRETS_KEY]: undefined }))
      const dir = mkdtempSync(join(tmpdir(), 'settings-key-missing-'))
      local.add(() => rmSync(dir, { recursive: true, force: true }))
      const target = join(dir, 'store.sqlite')
      const keyless = await openStore({
        dialect: 'sqlite',
        target,
        config: settingsConfig('sqlite', {
          email: { provider: 'smtp', config: { smtp: { host: '127.0.0.1', port: 2525 } } },
        }),
      })
      local.add(() => keyless.stop())
      const value = `smtp-pass-settings-${randomUUID()}`
      const res = await putSetting(await keyless.admin(), 'email', 'smtp.pass', value)
      expect(res.status, JSON.stringify(res.body)).toBe(503)
      expect(res.body.error?.code).toBe('settings.key_missing')
      expect(JSON.stringify(res.body)).not.toContain(value)
      const keylessRows = openReader('sqlite', target)
      local.add(() => keylessRows.close())
      expect((await storedSettings(keylessRows)).length).toBeLessThan(1)
    } finally {
      await local.run()
    }
  }, 60_000)
})
