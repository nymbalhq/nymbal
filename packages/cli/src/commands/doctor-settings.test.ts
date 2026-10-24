import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  cleanups,
  leaks,
  newSecretsKey,
  saveSettings,
  secretArb,
  SECRETS_KEY,
  setEnv,
  settingsConfig,
  settingsConfigInput,
  startStub,
  stripeBlock,
} from '../../../platform/tests/support/settings.js'
import { cliEnv, doctorJson, doctorLines, runCli } from '../../../../tests/support/doctor.js'

// AC-4: with a Stripe secretKey held only in Settings, `nymbal doctor` (and `--json`) reports payments healthy and
// prints neither the value nor its base64. Needs `pnpm build`. The in-process half is
// packages/platform/tests/integration/settings-write-only.test.ts.

describe('AC-4: doctor on a store whose key is held in Settings', () => {
  it('AC-4: over generated secrets, doctor and doctor --json report payments healthy and print neither the value nor its base64', async () => {
    await fc.assert(
      fc.asyncProperty(secretArb, async (secret) => {
        const run = cleanups()
        try {
          const key = newSecretsKey()
          run.add(
            setEnv({
              [SECRETS_KEY]: key,
              STRIPE_SECRET_KEY: undefined,
              STRIPE_WEBHOOK_SECRET: undefined,
            }),
          )
          const stub = await startStub('stripe')
          run.add(() => stub.close())
          stub.accept = (credential) => credential === secret
          const commerce = {
            payments: stripeBlock(stub, { webhookSecret: 'whsec_settings_doctor' }),
          }
          const dir = mkdtempSync(join(tmpdir(), 'settings-doctor-'))
          run.add(() => rmSync(dir, { recursive: true, force: true }))
          writeFileSync(
            join(dir, 'nymbal.config.ts'),
            `export default ${JSON.stringify(settingsConfigInput('sqlite', commerce), null, 2)}\n`,
          )
          const db = join(dir, 'nymbal.db')
          await saveSettings(
            { dialect: 'sqlite', target: db, config: settingsConfig('sqlite', commerce) },
            [['payments', 'secretKey', secret]],
          )
          stub.reset()

          const env = cliEnv({
            NYMBAL_SQLITE_PATH: db,
            [SECRETS_KEY]: key,
            STRIPE_SECRET_KEY: undefined,
            STRIPE_WEBHOOK_SECRET: undefined,
            STRIPE_PUBLISHABLE_KEY: undefined,
          })
          const text = await runCli(['doctor'], { cwd: dir, env })
          const json = await runCli(['doctor', '--json'], { cwd: dir, env })

          expect(stub.credentials().filter((c) => c === secret).length).toBeGreaterThan(0)
          expect(
            doctorLines(text.out).find((l) => l.name === 'slot payments')?.status,
            text.out,
          ).toBe('ok')
          expect(
            doctorJson(json.stdout).checks.find((c) => c.name === 'slot payments')?.status,
          ).toBe('ok')
          expect(leaks([text.out], secret)).toEqual([])
          expect(leaks([json.out], secret)).toEqual([])
        } finally {
          await run.run()
        }
      }),
      { numRuns: 3 },
    )
  }, 180_000)
})
