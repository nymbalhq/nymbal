import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { AdapterError } from '@nymbalhq/types'
import {
  captureLogs,
  cleanups,
  leaks,
  newSecretsKey,
  openStore,
  putSetting,
  secretArb,
  SECRETS_KEY,
  setEnv,
  settingsConfig,
  settingsField,
  startStub,
  stringsIn,
  anthropicBlock,
  openReader,
  STUB_SUGGESTION,
} from '../support/settings.js'

// P3-07 AC-4 (spec P3-07-secrets-settings, Decision 7), on SQLite: a secret saved through Settings is write-only.
// Property over generated secret values (16-64 characters from base64's alphabet and URL-unsafe punctuation): after an
// admin PUT of the AI slot's apiKey (Anthropic, its stub at the declared baseUrl), neither the value nor its base64 appears in
// - GET /api/admin/settings, before and after a restart;
// - the PUT's own response, and the 400s of two malformed PUTs carrying the value;
// - every log record the API wrote across boot, write, restart and an adapter error, captured both as a caller's own
//   Logger received it (objects, Errors included) and as `createLogger({ destination })` wrote it (parsed JSON lines);
// - product enhance answered by the stub with the loaded key, and the response of the same route once its adapter
//   throws an error carrying the key in its context;
// - the `settings.changed` event's envelope in the event log, which still names slot, path and source.
// The CLI half (`nymbal doctor` and `--json` on a store whose key is held in Settings) is
// packages/cli/src/commands/doctor-settings.test.ts.
// Kills: any leak path in the spec's Context: the logger, an error's context, the envelope, the listing.

describe('P3-07 AC-4: a saved secret never leaves the process', () => {
  it('AC-4: over generated secrets, no listing, PUT answer, 400, log record, adapter error response or settings.changed envelope carries the value or its base64', async () => {
    await fc.assert(
      fc.asyncProperty(secretArb, async (secret) => {
        const run = cleanups()
        try {
          run.add(
            setEnv({
              [SECRETS_KEY]: newSecretsKey(),
              ANTHROPIC_API_KEY: undefined,
            }),
          )
          const stub = await startStub('anthropic')
          run.add(() => stub.close())
          const dir = mkdtempSync(join(tmpdir(), 'p3-07-write-only-'))
          run.add(() => rmSync(dir, { recursive: true, force: true }))
          const target = join(dir, 'store.sqlite')
          const config = settingsConfig('sqlite', { ai: anthropicBlock(stub) })
          const logs = captureLogs()
          const bodies: string[] = []

          const first = await openStore({ dialect: 'sqlite', target, config, logger: logs.logger })
          run.add(() => first.stop())
          const admin = await first.admin()
          const put = await putSetting(admin, 'ai', 'apiKey', secret)
          expect(put.status, JSON.stringify(put.body)).toBe(200)
          bodies.push(JSON.stringify(put.body))
          for (const malformed of [{ value: [secret] }, { valu: secret }]) {
            const bad = await admin.call('PUT', '/api/admin/settings/ai/apiKey', malformed)
            expect(bad.status, JSON.stringify(bad.body)).toBe(400)
            bodies.push(JSON.stringify(bad.body))
          }
          const listedBefore = await admin.call('GET', '/api/admin/settings')
          expect(listedBefore.status).toBe(200)
          expect(settingsField(listedBefore.body.data, 'ai', 'apiKey')?.state).toBe('set')
          bodies.push(JSON.stringify(listedBefore.body))
          await first.stop()

          const second = await openStore({ dialect: 'sqlite', target, config, logger: logs.logger })
          run.add(() => second.stop())
          const again = await second.admin()
          const listedAfter = await again.call('GET', '/api/admin/settings')
          expect(listedAfter.status).toBe(200)
          expect(settingsField(listedAfter.body.data, 'ai', 'apiKey')?.source).toBe('settings')
          bodies.push(JSON.stringify(listedAfter.body))

          const enhance = () =>
            again.call<{ suggestion: string }>('POST', '/api/admin/products/p3-07/enhance', {
              field: 'description',
              context: { name: 'Write-only Widget' },
            })
          const answered = await enhance()
          expect(answered.body.data?.suggestion, JSON.stringify(answered.body)).toBe(
            STUB_SUGGESTION,
          )
          expect(stub.credentials().filter((c) => c === secret).length).toBeGreaterThan(0)
          bodies.push(JSON.stringify(answered.body))

          // An adapter error thrown in a route, carrying the key in its context.
          second.app.adapters.ai!.complete = async () => {
            throw new AdapterError('provider_failed', 'Anthropic call failed', {
              context: { slot: 'ai', apiKey: secret, nested: { key: secret } },
            })
          }
          const failed = await enhance()
          expect(failed.status).toBeGreaterThanOrEqual(500)
          bodies.push(JSON.stringify(failed.body))
          await second.stop()

          const raw = openReader('sqlite', target)
          run.add(() => raw.close())
          const changed = await raw.rows<{ envelope: string | object }>(
            "SELECT envelope FROM events WHERE type LIKE 'settings.changed%' ORDER BY seq",
          )
          expect(changed.length).toBeGreaterThan(0)
          const envelopes = changed.map((row) =>
            typeof row.envelope === 'string' ? (JSON.parse(row.envelope) as object) : row.envelope,
          )
          const payload = (envelopes[0] as { payload?: Record<string, unknown> }).payload ?? {}
          expect([payload['slot'], payload['path'], payload['source']]).toEqual([
            'ai',
            'apiKey',
            'settings',
          ])

          expect(logs.written().length).toBeGreaterThan(0)
          expect(leaks(bodies, secret)).toEqual([])
          expect(leaks(logs.strings(), secret)).toEqual([])
          expect(leaks(stringsIn(envelopes), secret)).toEqual([])
        } finally {
          await run.run()
        }
      }),
      { numRuns: 6 },
    )
  }, 240_000)
})
