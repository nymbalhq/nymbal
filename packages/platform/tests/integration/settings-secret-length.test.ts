import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AdapterError, SECRET_MIN_LENGTH } from '@nymbalhq/types'
import {
  anthropicBlock,
  captureLogs,
  cleanups,
  leaks,
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
} from '../support/settings.js'

// P3-07 (spec P3-07-secrets-settings, diff review M1), on SQLite: the scrub set skips values shorter than
// SECRET_MIN_LENGTH, so Settings refuses a secret that short. A 7-character apiKey PUT answers 400 with
// `settings.secret_too_short`, naming ai.apiKey and the minimum and never the value, and writes no row and no
// `settings.changed`; an 8-character one is saved, and an adapter error carrying it reaches neither the 5xx body nor
// any log record. A non-secret field still takes one character.
// Kills: a short secret accepted, used and logged unmasked.

const SHORT = 'Zq!7#wK'
const SHORTEST_ACCEPTED = 'Zq!7#wK@'

describe('P3-07 M1: a secret shorter than the scrub minimum is refused', () => {
  const scope = cleanups()
  afterEach(() => scope.run())

  async function begin(block: (stub: Awaited<ReturnType<typeof startStub>>) => unknown) {
    scope.add(setEnv({ [SECRETS_KEY]: newSecretsKey(), ANTHROPIC_API_KEY: undefined }))
    const stub = await startStub('anthropic')
    scope.add(() => stub.close())
    const dir = mkdtempSync(join(tmpdir(), 'p3-07-secret-length-'))
    scope.add(() => rmSync(dir, { recursive: true, force: true }))
    const target = join(dir, 'store.sqlite')
    const logs = captureLogs()
    const store = await openStore({
      dialect: 'sqlite',
      target,
      config: settingsConfig('sqlite', { ai: block(stub) }),
      logger: logs.logger,
    })
    scope.add(() => store.stop())
    const raw = openReader('sqlite', target)
    scope.add(() => raw.close())
    return { store, admin: await store.admin(), raw, logs }
  }

  const changedEvents = (raw: ReturnType<typeof openReader>) =>
    raw.rows<{ seq: number }>("SELECT seq FROM events WHERE type LIKE 'settings.changed%'")

  it('M1: a 7-character apiKey PUT answers 400 naming ai.apiKey and the minimum, and writes no row and no event; an 8-character one is saved and scrubbed from a 5xx body and the logs', async () => {
    expect(SHORT.length).toBe(SECRET_MIN_LENGTH - 1)
    expect(SHORTEST_ACCEPTED.length).toBe(SECRET_MIN_LENGTH)
    const { store, admin, raw, logs } = await begin((stub) => anthropicBlock(stub))

    const refused = await putSetting(admin, 'ai', 'apiKey', SHORT)
    expect(refused.status, JSON.stringify(refused.body)).toBe(400)
    const error = (refused.body as { error?: { code?: string; message?: string } }).error
    expect(error?.code).toBe('settings.secret_too_short')
    expect(error?.message).toContain('ai.apiKey')
    expect(error?.message).toContain(String(SECRET_MIN_LENGTH))
    expect(JSON.stringify(refused.body)).not.toContain(SHORT)
    expect(await storedSettings(raw)).toEqual([])
    expect(await changedEvents(raw)).toEqual([])
    const listed = await admin.call('GET', '/api/admin/settings')
    expect(settingsField(listed.body.data, 'ai', 'apiKey')?.state).toBe('unset')

    const saved = await putSetting(admin, 'ai', 'apiKey', SHORTEST_ACCEPTED)
    expect(saved.status, JSON.stringify(saved.body)).toBe(200)
    const rows = await storedSettings(raw)
    expect(rows.map((r) => [r.slot, r.path, r.plain])).toEqual([['ai', 'apiKey', null]])
    expect((await changedEvents(raw)).length).toBe(1)

    store.app.adapters.ai!.complete = async () => {
      throw new AdapterError('provider_failed', `Anthropic refused ${SHORTEST_ACCEPTED}`, {
        context: { slot: 'ai', apiKey: SHORTEST_ACCEPTED },
      })
    }
    const failed = await admin.call('POST', '/api/admin/products/p3-07/enhance', {
      field: 'description',
      context: { name: 'Short Key Widget' },
    })
    expect(failed.status).toBeGreaterThanOrEqual(500)
    expect(leaks([JSON.stringify(failed.body)], SHORTEST_ACCEPTED)).toEqual([])
    expect(logs.written().length).toBeGreaterThan(0)
    expect(leaks(logs.strings(), SHORTEST_ACCEPTED)).toEqual([])
    expect(leaks(logs.strings(), SHORT)).toEqual([])
  }, 60_000)

  it('M1: a non-secret field (ai.baseUrl) still takes a one-character value', async () => {
    const { admin, raw } = await begin(() => ({ provider: 'anthropic', config: {} }))
    const saved = await putSetting(admin, 'ai', 'baseUrl', 'x')
    expect(saved.status, JSON.stringify(saved.body)).toBe(200)
    const rows = await storedSettings(raw)
    expect(rows.map((r) => [r.slot, r.path, r.plain])).toEqual([['ai', 'baseUrl', 'x']])
  }, 60_000)
})
