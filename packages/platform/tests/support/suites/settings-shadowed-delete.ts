import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type { Dialect } from '../kernel.js'
import {
  anthropicBlock,
  cleanups,
  newSecretsKey,
  openReader,
  openStore,
  putSetting,
  saveSetting,
  SECRETS_KEY,
  setEnv,
  settingsConfig,
  settingsField,
  startStub,
  storedSettings,
  type ApiClient,
  type Store,
} from '../settings.js'
import type { SuiteTarget } from './settings-restart.js'

// A row saved in Settings for a field that the environment or the config came to set afterwards is never used, and the
// boot says so on every start while it exists. An admin can delete it: DELETE answers 200 with the source that still
// sets the field, and the row is gone. PUT to such a field is still refused, and the other DELETE answers are as they
// were. On one dialect (each caller names it).

const ENV_FIELD = { slot: 'ai', path: 'apiKey', env: 'ANTHROPIC_API_KEY' } as const
const CONFIG_FIELD = { slot: 'email', path: 'smtp.pass' } as const
const SMTP = { host: '127.0.0.1', port: 2525 }

const settingPath = (slot: string, path: string) =>
  `/api/admin/settings/${encodeURIComponent(slot)}/${encodeURIComponent(path)}`

export function settingsShadowedDeleteSuite(
  dialect: Dialect,
  makeTarget: () => Promise<SuiteTarget>,
): void {
  describe(`DELETE of a setting the environment or config shadows (${dialect})`, () => {
    const scope = cleanups()
    afterEach(() => scope.run())

    async function begin(): Promise<string> {
      scope.add(setEnv({ [SECRETS_KEY]: newSecretsKey(), [ENV_FIELD.env]: undefined }))
      const db = await makeTarget()
      scope.add(() => db.drop())
      return db.target
    }

    async function boot(target: string, commerce: Record<string, unknown>): Promise<Store> {
      const store = await openStore({ dialect, target, config: settingsConfig(dialect, commerce) })
      scope.add(() => store.stop())
      return store
    }

    function rowsOf(target: string) {
      const raw = openReader(dialect, target)
      scope.add(() => raw.close())
      return async (slot: string, path: string) =>
        (await storedSettings(raw)).filter((r) => r.slot === slot && r.path === path)
    }

    async function view(admin: ApiClient, slot: string, path: string) {
      const listing = await admin.call('GET', '/api/admin/settings')
      const field = settingsField(listing.body.data, slot, path)
      return [field?.source ?? null, field?.state]
    }

    /** A row for the env field, saved while the variable was unset; the store is then booted with it set. */
    async function envShadowed() {
      const target = await begin()
      const stub = await startStub('anthropic')
      scope.add(() => stub.close())
      // The SMTP block sets no user, so email smtp.user is a field nothing shadows.
      const commerce = {
        ai: anthropicBlock(stub),
        email: { provider: 'smtp', config: { smtp: SMTP } },
      }
      const first = await boot(target, commerce)
      await saveSetting(
        await first.admin(),
        ENV_FIELD.slot,
        ENV_FIELD.path,
        `sk-ant-saved-${randomUUID()}`,
      )
      await first.stop()
      scope.add(setEnv({ [ENV_FIELD.env]: `sk-ant-env-${randomUUID()}` }))
      const store = await boot(target, commerce)
      return { target, commerce, store, admin: await store.admin(), rows: rowsOf(target) }
    }

    it("AC-9: a stored row for a field the env sets: DELETE answers 200 { state: 'set', source: 'env' }, the row is gone, and after a restart the field is listed ['env', 'set']", async () => {
      const { target, commerce, store, admin, rows } = await envShadowed()
      const before = await rows(ENV_FIELD.slot, ENV_FIELD.path)
      expect(await view(admin, ENV_FIELD.slot, ENV_FIELD.path)).toEqual(['env', 'set'])

      const res = await admin.call<{ state: string; source: string | null }>(
        'DELETE',
        settingPath(ENV_FIELD.slot, ENV_FIELD.path),
      )
      expect(res.status, JSON.stringify(res.body)).toBe(200)
      expect([res.body.data?.state, res.body.data?.source]).toEqual(['set', 'env'])
      expect((await rows(ENV_FIELD.slot, ENV_FIELD.path)).length).toBe(before.length - 1)

      await store.stop()
      const again = await boot(target, commerce)
      expect(await view(await again.admin(), ENV_FIELD.slot, ENV_FIELD.path)).toEqual([
        'env',
        'set',
      ])
    }, 60_000)

    it("AC-9: a stored row for a field the config block sets: DELETE answers 200 { state: 'set', source: 'config' }, the row is gone, and after a restart the field is listed ['config', 'set']", async () => {
      const target = await begin()
      const rows = rowsOf(target)
      const first = await boot(target, { email: { provider: 'smtp', config: { smtp: SMTP } } })
      await saveSetting(
        await first.admin(),
        CONFIG_FIELD.slot,
        CONFIG_FIELD.path,
        `smtp-saved-${randomUUID()}`,
      )
      await first.stop()
      const shadowed = {
        email: {
          provider: 'smtp',
          config: { smtp: { ...SMTP, pass: `smtp-config-${randomUUID()}` } },
        },
      }
      const store = await boot(target, shadowed)
      const admin = await store.admin()
      const before = await rows(CONFIG_FIELD.slot, CONFIG_FIELD.path)
      expect(await view(admin, CONFIG_FIELD.slot, CONFIG_FIELD.path)).toEqual(['config', 'set'])

      const res = await admin.call<{ state: string; source: string | null }>(
        'DELETE',
        settingPath(CONFIG_FIELD.slot, CONFIG_FIELD.path),
      )
      expect(res.status, JSON.stringify(res.body)).toBe(200)
      expect([res.body.data?.state, res.body.data?.source]).toEqual(['set', 'config'])
      expect((await rows(CONFIG_FIELD.slot, CONFIG_FIELD.path)).length).toBe(before.length - 1)

      await store.stop()
      const again = await boot(target, shadowed)
      expect(await view(await again.admin(), CONFIG_FIELD.slot, CONFIG_FIELD.path)).toEqual([
        'config',
        'set',
      ])
    }, 60_000)

    it("AC-10: with that row stored, a PUT to the env-shadowed field still answers 409 settings.set_by_environment and leaves the row as it was; DELETE of an unshadowed stored field answers { state: 'unset', source: null } and removes it; DELETE of an undeclared field answers 404", async () => {
      const { admin, rows } = await envShadowed()
      const before = await rows(ENV_FIELD.slot, ENV_FIELD.path)
      const put = await putSetting(
        admin,
        ENV_FIELD.slot,
        ENV_FIELD.path,
        `sk-ant-put-${randomUUID()}`,
      )
      expect(put.status, JSON.stringify(put.body)).toBe(409)
      expect(put.body.error?.code).toBe('settings.set_by_environment')
      expect(await rows(ENV_FIELD.slot, ENV_FIELD.path)).toEqual(before)

      const unshadowed = { slot: 'email', path: 'smtp.user' }
      await saveSetting(admin, unshadowed.slot, unshadowed.path, `shop-${randomUUID()}`)
      const stored = await rows(unshadowed.slot, unshadowed.path)
      const deleted = await admin.call<{ state: string; source: string | null }>(
        'DELETE',
        settingPath(unshadowed.slot, unshadowed.path),
      )
      expect(deleted.status, JSON.stringify(deleted.body)).toBe(200)
      expect([deleted.body.data?.state, deleted.body.data?.source]).toEqual(['unset', null])
      expect((await rows(unshadowed.slot, unshadowed.path)).length).toBe(stored.length - 1)

      const unknown = await admin.call('DELETE', settingPath('ai', 'notDeclared'))
      expect(unknown.status, JSON.stringify(unknown.body)).toBe(404)
      expect(unknown.body.error?.code).toBe('settings.unknown_field')
    }, 60_000)
  })
}
