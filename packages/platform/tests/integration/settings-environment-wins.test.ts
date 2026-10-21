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

// P3-07 AC-5 (spec P3-07-secrets-settings, ruling 3, Decision 6), on SQLite. A store whose AI slot (Anthropic) takes
// `apiKey` from ANTHROPIC_API_KEY (its declared env) and `baseUrl` from the config, and whose email slot (SMTP) has
// `smtp.pass` in the config and `smtp.user` set nowhere. The listing gives `source: 'env'` and `'config'` for those,
// state set, no `value` for a secret (and neither secret anywhere in the body), the value for the non-secret baseUrl;
// a PUT to any of them answers 409 `settings.set_by_environment` and writes no row, while a PUT to `smtp.user` writes
// one. A token without the admin role gets 403 from GET, PUT and DELETE and changes no row.
// Kills: the admin overriding a deploy's env or config; a customer writing keys.

const ENV_API_KEY = `sk-ant-p3-07-from-env-${randomUUID()}`
const CONFIG_SMTP_PASS = `smtp-pass-p3-07-from-config-${randomUUID()}`

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
  const dir = mkdtempSync(join(tmpdir(), 'p3-07-env-wins-'))
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

describe('P3-07 AC-5: the environment wins in the API', () => {
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
      const res = await putSetting(admin, slot, path, `p3-07-override-${randomUUID()}`)
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
})
