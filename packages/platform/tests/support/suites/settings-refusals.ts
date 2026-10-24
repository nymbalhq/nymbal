import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ConfigError } from '@nymbalhq/types'
import type { Dialect } from '../kernel.js'
import {
  anthropicBlock,
  attemptStore,
  captureLogs,
  cleanups,
  migrationsBefore0008,
  newSecretsKey,
  openReader,
  openStore,
  saveSettings,
  SECRETS_KEY,
  setEnv,
  settingsConfig,
  settingsField,
  startStub,
  storedSettings,
  stripeBlock,
  tamperCiphertext,
  type Stub,
} from '../settings.js'
import type { SuiteTarget } from './settings-restart.js'

// AC-6 on one dialect: boot refuses, with a ConfigError naming the slot and path and never the value, before any
// adapter request, when a settings row the fill would use cannot be read: a secret row with NYMBAL_SECRETS_KEY unset,
// a malformed key (not 32 bytes of base64), a key whose key_id differs, a tampered row. The refused boot changes no
// row. The row is the AI slot's `apiKey` (Anthropic, its stub at the declared baseUrl), a store that boots without
// it, so each case is red on the refusal itself.
// Boots that need no key: a store with no rows, a store from before migration 0008 (no settings relation), and
// (SQLite) a Stripe store from `nymbal add stripe` whose database file does not exist yet (`nymbal import` on a fresh
// scaffold), which gets past the settings read to open its store. A row that env (ANTHROPIC_API_KEY, the declared env)
// shadows is not decrypted: boot without the key succeeds and logs a warning naming slot and path.
// `nymbal secrets clear` is spawned in packages/cli/src/commands/secrets-clear.test.ts.

const PROVIDER_ENV = {
  ANTHROPIC_API_KEY: undefined,
  STRIPE_SECRET_KEY: undefined,
  STRIPE_WEBHOOK_SECRET: undefined,
  STRIPE_PUBLISHABLE_KEY: undefined,
}

/** Does `text` name the slot `ai` (as a word) and the path `apiKey`? */
const namesAiApiKey = (text: string): boolean => /\bai\b/.test(text) && text.includes('apiKey')

export function settingsRefusalsSuite(
  dialect: Dialect,
  makeTarget: () => Promise<SuiteTarget>,
): void {
  describe(`AC-6: boot refusals (${dialect})`, () => {
    const scope = cleanups()
    afterEach(() => scope.run())

    async function begin(
      kind: 'anthropic' | 'stripe' = 'anthropic',
    ): Promise<{ stub: Stub; target: string; key: string }> {
      const key = newSecretsKey()
      scope.add(setEnv({ ...PROVIDER_ENV, [SECRETS_KEY]: key }))
      const stub = await startStub(kind)
      scope.add(() => stub.close())
      const db = await makeTarget()
      scope.add(() => db.drop())
      return { stub, target: db.target, key }
    }

    const configFor = (stub: Stub) => settingsConfig(dialect, { ai: anthropicBlock(stub) })

    /** A store holding one secret row, `ai.apiKey`, saved through the admin API under the current key. */
    async function withSecretRow(stub: Stub, target: string): Promise<string> {
      const value = `sk-ant-settings-${randomUUID()}`
      await saveSettings({ dialect, target, config: configFor(stub) }, [['ai', 'apiKey', value]])
      stub.reset()
      return value
    }

    async function expectRefused(stub: Stub, target: string, value: string): Promise<void> {
      const raw = openReader(dialect, target)
      scope.add(() => raw.close())
      const before = await storedSettings(raw)
      const outcome = await attemptStore({ dialect, target, config: configFor(stub) })
      if (outcome.store !== undefined) scope.add(() => outcome.store.stop())
      expect(outcome.error).toBeInstanceOf(ConfigError)
      const error = outcome.error as ConfigError
      expect(namesAiApiKey(error.message), error.message).toBe(true)
      expect(JSON.stringify({ message: error.message, error: error.toJSON() })).not.toContain(value)
      expect(stub.calls).toEqual([])
      expect(before).toEqual(await storedSettings(raw))
    }

    it('AC-6: a secret row with NYMBAL_SECRETS_KEY unset refuses boot with a ConfigError naming ai.apiKey, before any adapter request', async () => {
      const { stub, target } = await begin()
      const value = await withSecretRow(stub, target)
      scope.add(setEnv({ [SECRETS_KEY]: undefined }))
      await expectRefused(stub, target, value)
    }, 60_000)

    it.each([
      ['16 bytes of base64', randomBytes(16).toString('base64')],
      ['48 bytes of base64', randomBytes(48).toString('base64')],
      ['not base64', 'not-a-key: ??? !!!'],
    ])(
      'AC-6: a malformed NYMBAL_SECRETS_KEY (%s) refuses boot naming ai.apiKey',
      async (_, malformed) => {
        const { stub, target } = await begin()
        const value = await withSecretRow(stub, target)
        scope.add(setEnv({ [SECRETS_KEY]: malformed }))
        await expectRefused(stub, target, value)
      },
      60_000,
    )

    it("AC-6: a well-formed key whose key_id differs from the row's refuses boot naming ai.apiKey", async () => {
      const { stub, target, key } = await begin()
      const value = await withSecretRow(stub, target)
      const other = newSecretsKey()
      expect(other).not.toBe(key)
      scope.add(setEnv({ [SECRETS_KEY]: other }))
      await expectRefused(stub, target, value)
    }, 60_000)

    it('AC-6: a row whose ciphertext was tampered with refuses boot naming ai.apiKey, under the right key', async () => {
      const { stub, target } = await begin()
      const value = await withSecretRow(stub, target)
      const raw = openReader(dialect, target)
      scope.add(() => raw.close())
      await tamperCiphertext(dialect, raw, target, 'ai', 'apiKey')
      await expectRefused(stub, target, value)
    }, 60_000)

    it('AC-6: a store with no rows boots with NYMBAL_SECRETS_KEY unset, and its admin lists apiKey unset', async () => {
      const { stub, target } = await begin()
      scope.add(setEnv({ [SECRETS_KEY]: undefined }))
      const store = await openStore({ dialect, target, config: configFor(stub) })
      scope.add(() => store.stop())
      const listing = await (await store.admin()).call('GET', '/api/admin/settings')
      expect(listing.status, JSON.stringify(listing.body)).toBe(200)
      expect(settingsField(listing.body.data, 'ai', 'apiKey')?.state).toBe('unset')
      const raw = openReader(dialect, target)
      scope.add(() => raw.close())
      expect((await storedSettings(raw)).length).toBeLessThan(1)
    }, 60_000)

    it('AC-6: a store migrated only to 0007 (no settings relation) boots with NYMBAL_SECRETS_KEY unset, and its admin lists apiKey unset', async () => {
      const { stub, target } = await begin()
      scope.add(setEnv({ [SECRETS_KEY]: undefined }))
      const before0008 = migrationsBefore0008(dialect)
      scope.add(() => before0008.drop())
      const store = await openStore({
        dialect,
        target,
        config: configFor(stub),
        migrationsRoot: before0008.root,
      })
      scope.add(() => store.stop())
      const listing = await (await store.admin()).call('GET', '/api/admin/settings')
      expect(listing.status, JSON.stringify(listing.body)).toBe(200)
      expect(settingsField(listing.body.data, 'ai', 'apiKey')?.state).toBe('unset')
    }, 60_000)

    if (dialect === 'sqlite') {
      it('AC-6: a Stripe store with no database file yet (`nymbal import` on a fresh scaffold) and no key gets past the settings read and opens its store', async () => {
        const { stub } = await begin('stripe')
        scope.add(setEnv({ [SECRETS_KEY]: undefined }))
        const dir = mkdtempSync(join(tmpdir(), 'settings-no-file-'))
        scope.add(() => rmSync(dir, { recursive: true, force: true }))
        const target = join(dir, 'nymbal.db')
        expect(existsSync(target)).toBe(false)
        const outcome = await attemptStore({
          dialect,
          target,
          config: settingsConfig(dialect, { payments: stripeBlock(stub) }),
          migrate: false,
        })
        if (outcome.store !== undefined) scope.add(() => outcome.store.stop())
        // An unmigrated file still fails later, at warm-up, as it does today without settings; the settings read (or a
        // slot it leaves unconfigured) must not be what stops it.
        const message = outcome.error instanceof Error ? outcome.error.message : ''
        expect(outcome.error).not.toBeInstanceOf(ConfigError)
        expect(message).not.toMatch(/unable to open database file/i)
        expect(existsSync(target), `createApp stopped before opening its store: ${message}`).toBe(
          true,
        )
      }, 60_000)
    }

    it('AC-6: a row that ANTHROPIC_API_KEY shadows does not refuse a boot without the key; it logs a warning naming ai and apiKey', async () => {
      const { stub, target } = await begin()
      await withSecretRow(stub, target)
      scope.add(
        setEnv({
          [SECRETS_KEY]: undefined,
          ANTHROPIC_API_KEY: `sk-ant-settings-env-${randomUUID()}`,
        }),
      )
      const logs = captureLogs()
      const store = await openStore({
        dialect,
        target,
        config: configFor(stub),
        logger: logs.logger,
      })
      scope.add(() => store.stop())
      const warnings = logs.calls
        .filter((call) => call.level === 'warn')
        .map((call) => JSON.stringify({ obj: call.obj, msg: call.msg, bindings: call.bindings }))
        .filter(namesAiApiKey)
      expect(warnings.length, 'a warning naming ai and apiKey').toBeGreaterThan(0)
    }, 60_000)
  })
}
