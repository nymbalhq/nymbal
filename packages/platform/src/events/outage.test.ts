import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { HealthReport } from '@nymbalhq/types'
import { createNotConfiguredAdapter, isNotConfigured } from '../adapters/not-configured.js'
import { createOutageProbe, type OutageSubject } from './outage.js'

// The outage probe over the subjects the app hands it: an outage is any subject that answers `down`, throws or does
// not answer within the bound; `healthy`, `degraded` and a subject with no health check are not; a not-configured
// placeholder, which answers `down` for ever, is skipped (AC-3).

const TIMEOUT_MS = 30

/** One entry of a report's `down` list. */
interface Down {
  name: string
  detail: string
}

type Kind = 'healthy' | 'degraded' | 'down' | 'throws' | 'hangs' | 'no-check' | 'placeholder'
const OUTAGE_KINDS: ReadonlySet<Kind> = new Set(['down', 'throws', 'hangs'])

interface Planned {
  kind: Kind
  detail: string
}

function subjectOf({ kind, detail }: Planned, name: string): OutageSubject {
  switch (kind) {
    case 'healthy':
    case 'degraded':
    case 'down':
      return { name, healthCheck: async (): Promise<HealthReport> => ({ status: kind, detail }) }
    case 'throws':
      return {
        name,
        healthCheck: async () => {
          throw new Error(detail)
        },
      }
    case 'hangs':
      return { name, healthCheck: () => new Promise<HealthReport>(() => undefined) }
    case 'no-check':
      return { name }
    case 'placeholder':
      return Object.assign(
        createNotConfiguredAdapter('payments', 'stripe', ['secretKey']) as object,
        {
          name,
        },
      ) as OutageSubject
  }
}

const planned = fc.record({
  kind: fc.constantFrom<Kind>(
    'healthy',
    'degraded',
    'down',
    'throws',
    'hangs',
    'no-check',
    'placeholder',
  ),
  detail: fc.stringMatching(/^[a-z][a-z0-9 :.-]{2,24}$/),
})

describe('AC-3: createOutageProbe', () => {
  it('AC-3: property: over any mix of subjects, the report is an outage exactly when a checked subject answers down, throws or times out, and lists exactly those subjects, each with its health detail or error message; healthy, degraded, no health check and a not-configured placeholder are never listed', async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(planned, { minLength: 0, maxLength: 7 }), async (plan) => {
        const names = plan.map((p, i) => `${p.kind}-${i}`)
        const probe = createOutageProbe(
          plan.map((p, i) => subjectOf(p, names[i]!)),
          { timeoutMs: TIMEOUT_MS },
        )

        const report = await probe()

        const expected = plan.flatMap((p, i) => (OUTAGE_KINDS.has(p.kind) ? [names[i]!] : []))
        expect(report.outage).toBe(expected.length > 0)
        expect(report.down.map((d: Down) => d.name).sort()).toEqual([...expected].sort())
        for (const d of report.down as readonly Down[]) {
          const p = plan[names.indexOf(d.name)]!
          // A timed-out check's detail is the bound; the rest carry their own detail or message.
          expect(d.detail).toContain(p.kind === 'hangs' ? `${TIMEOUT_MS} ms` : p.detail)
        }
      }),
      { numRuns: 60 },
    )
  })

  it('AC-3: a not-configured placeholder answers down but is marked, and a probe over it alone, or beside healthy subjects, reports no outage; the same down answer from a configured adapter is an outage', async () => {
    const placeholder = subjectOf({ kind: 'placeholder', detail: '' }, 'payments')
    const configured = subjectOf({ kind: 'down', detail: 'stripe: Invalid API Key' }, 'payments')
    const healthy = subjectOf({ kind: 'healthy', detail: 'ok' }, 'email')

    expect((await placeholder.healthCheck!()).status).toBe('down')
    expect([isNotConfigured(placeholder), isNotConfigured(configured)]).toEqual([true, false])

    const alone = await createOutageProbe([placeholder], { timeoutMs: TIMEOUT_MS })()
    const beside = await createOutageProbe([placeholder, healthy], { timeoutMs: TIMEOUT_MS })()
    const real = await createOutageProbe([configured, healthy], { timeoutMs: TIMEOUT_MS })()

    expect([alone, beside]).toEqual([
      { outage: false, down: [] },
      { outage: false, down: [] },
    ])
    expect(real).toEqual({
      outage: true,
      down: [{ name: 'payments', detail: 'stripe: Invalid API Key' }],
    })
  })
})
