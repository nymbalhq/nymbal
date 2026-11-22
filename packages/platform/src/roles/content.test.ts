import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { contentDrafts, proposalArgsOf } from './content.js'

// Two pure parts of the content role: the bound on what a model's answer may become (the role's declared fields, for
// a product the run selected), and the insight drafts a run's report gives the morning brief.

const FIELDS = ['seoTitle', 'seoDescription'] as const
const OUTSIDE = [
  'description',
  'shortDescription',
  'name',
  'status',
  'variants',
  'metadata',
  'id',
  'media',
] as const

const fieldsArb = fc.subarray([...FIELDS], { minLength: 1 })
const text = fc.string({ minLength: 1, maxLength: 80 })

describe('AC-8: proposalArgsOf, the fields and batch bound', () => {
  it('AC-8: property: an answer whose every key is a declared field, for a product in the batch, becomes args of the product id and exactly the answered fields', () => {
    fc.assert(
      fc.property(
        fieldsArb,
        fc.uuid(),
        fc.uniqueArray(fc.uuid(), { maxLength: 4 }),
        fc.dictionary(fc.constantFrom(...FIELDS), text),
        (fields, productId, others, raw) => {
          const answer = Object.fromEntries(
            Object.entries(raw).filter(([k]) => fields.includes(k as never)),
          )
          const batch = new Set([...others, productId])
          expect(proposalArgsOf(productId, answer, fields, batch)).toEqual({
            args: { id: productId, ...answer },
          })
        },
      ),
    )
  })

  it('AC-8: property: any key outside the declared fields is refused role.field_not_allowed with those keys as detail, a declared-out SEO field included', () => {
    fc.assert(
      fc.property(
        fieldsArb,
        fc.uuid(),
        fc.uniqueArray(fc.constantFrom(...OUTSIDE), { minLength: 1, maxLength: 3 }),
        (fields, productId, extra) => {
          const undeclared = FIELDS.filter((f) => !fields.includes(f))
          const answer: Record<string, unknown> = { [fields[0]!]: 'A title' }
          for (const k of [...extra, ...undeclared]) answer[k] = 'x'
          const result = proposalArgsOf(productId, answer, fields, new Set([productId])) as {
            refused?: string
            detail?: string[]
          }
          expect({ refused: result.refused, detail: [...(result.detail ?? [])].sort() }).toEqual({
            refused: 'role.field_not_allowed',
            detail: [...extra, ...undeclared].sort(),
          })
        },
      ),
    )
  })

  it('AC-8: property: a product outside the run’s batch is refused role.product_not_in_run, whatever the answer', () => {
    fc.assert(
      fc.property(
        fc.uuid(),
        fc.uniqueArray(fc.uuid(), { maxLength: 4 }),
        text,
        (productId, batchIds, title) => {
          fc.pre(!batchIds.includes(productId))
          const result = proposalArgsOf(
            productId,
            { seoTitle: title },
            [...FIELDS],
            new Set(batchIds),
          ) as {
            refused?: string
            args?: unknown
          }
          expect([result.refused, result.args]).toEqual(['role.product_not_in_run', undefined])
        },
      ),
    )
  })
})

const REASONS = ['validation', 'unsupported_claim', 'unparsed', 'field_not_allowed'] as const
type Reason = (typeof REASONS)[number]

/** A run's report, as the Interface states it. */
interface Report {
  candidates: number
  alreadyAsked: number
  asked: string[]
  proposed: Array<{ productId: string; proposalId: string; fields: string[] }>
  skipped: Array<{ productId: string; proposalId: string }>
  withheld: Array<{ productId: string; proposalId: string; reason: Reason; detail: string[] }>
  stopped: null | 'token_cap' | 'provider_failed'
  usage: {
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    cacheWriteTokens: number
  }
  models: string[]
}

interface Draft {
  subject: string
  severity: string
  summary: string
  facts: Record<string, string | number | null>
}

const draftsOf = (report: Report): Draft[] => contentDrafts(report)

/** A run's report: ids, outcomes and a detail of distinctive tokens no summary would print by chance. */
const reportArb: fc.Arbitrary<Report> = fc
  .record({
    ids: fc.uniqueArray(fc.uuid(), { maxLength: 20 }),
    outcomes: fc.array(fc.constantFrom('proposed', 'skipped', ...REASONS), {
      minLength: 20,
      maxLength: 20,
    }),
    details: fc.array(fc.stringMatching(/^zq[a-f0-9]{6}$/), { minLength: 20, maxLength: 20 }),
    stopped: fc.constantFrom(null, 'token_cap' as const, 'provider_failed' as const),
    usage: fc.record({
      inputTokens: fc.nat({ max: 200_000 }),
      outputTokens: fc.nat({ max: 50_000 }),
      cacheReadTokens: fc.nat({ max: 1000 }),
      cacheWriteTokens: fc.nat({ max: 1000 }),
    }),
    candidates: fc.nat({ max: 100 }),
    alreadyAsked: fc.nat({ max: 100 }),
  })
  .map(({ ids, outcomes, details, stopped, usage, candidates, alreadyAsked }) => {
    const proposalId = (i: number) => `prop-${ids[i]}`
    const report: Report = {
      candidates,
      alreadyAsked,
      asked: ids,
      proposed: [],
      skipped: [],
      withheld: [],
      stopped,
      usage,
      models: ['model-under-test'],
    }
    ids.forEach((productId, i) => {
      const outcome = outcomes[i]!
      if (outcome === 'proposed') {
        report.proposed.push({ productId, proposalId: proposalId(i), fields: ['seoTitle'] })
      } else if (outcome === 'skipped') {
        report.skipped.push({ productId, proposalId: proposalId(i) })
      } else {
        report.withheld.push({
          productId,
          proposalId: proposalId(i),
          reason: outcome,
          detail: [details[i]!],
        })
      }
    })
    return report
  })

const countOf = (report: Report, reason: Reason) =>
  report.withheld.filter((w) => w.reason === reason).length

/** The numbers a summary prints that no fact carries in its string form. */
function numbersNotInFacts(summary: string, facts: Record<string, unknown>): string[] {
  const carried = Object.values(facts).map((v) => String(v))
  return (summary.match(/\d+(?:\.\d+)?/g) ?? []).filter((n) => !carried.includes(n))
}

describe('AC-13: contentDrafts, the role’s insights', () => {
  it('AC-13: property: a run draft exactly when something was withheld or the cap stopped the run, a provider draft exactly when the provider failed, and none for a clean run', () => {
    fc.assert(
      fc.property(reportArb, (report) => {
        const expected = [
          ...(report.stopped === 'provider_failed' ? ['provider'] : []),
          ...(report.withheld.length > 0 || report.stopped === 'token_cap' ? ['run'] : []),
        ]
        const drafts = draftsOf(report)
        expect(drafts.map((d) => d.subject).sort()).toEqual(expected)
        expect(drafts.map((d) => [d.subject, d.severity])).toEqual(
          drafts.map((d) => [d.subject, d.subject === 'provider' ? 'warning' : 'info']),
        )
      }),
      { numRuns: 300 },
    )
  })

  it('AC-13: property: the facts are the report’s counts and stop reason, flat; every number a summary prints is a fact; no id or detail of the report reaches a draft', () => {
    fc.assert(
      fc.property(reportArb, (report) => {
        const tokens = report.usage.inputTokens + report.usage.outputTokens
        for (const draft of draftsOf(report)) {
          const facts = draft.facts as Record<string, unknown>
          expect(
            Object.values(facts).filter(
              (v) => v !== null && typeof v !== 'string' && typeof v !== 'number',
            ),
          ).toEqual([])
          expect(numbersNotInFacts(draft.summary, facts)).toEqual([])
          const printed = [draft.summary, ...Object.values(facts).map(String)].join('\n')
          const leaked = [
            ...report.asked,
            ...report.withheld.flatMap((w) => [w.proposalId, ...w.detail]),
            ...report.proposed.map((p) => p.proposalId),
            ...report.models,
          ].filter((t) => printed.includes(t))
          expect(leaked).toEqual([])
          const runFacts = {
            asked: report.asked.length,
            proposed: report.proposed.length,
            skipped: report.skipped.length,
            withheld: report.withheld.length,
            withheldValidation: countOf(report, 'validation'),
            withheldUnsupportedClaim: countOf(report, 'unsupported_claim'),
            withheldUnparsed: countOf(report, 'unparsed'),
            withheldFieldNotAllowed: countOf(report, 'field_not_allowed'),
            tokens,
            stopped: report.stopped === 'token_cap' ? 'token_cap' : null,
          }
          const providerFacts = {
            asked: report.asked.length,
            proposed: report.proposed.length,
            withheld: report.withheld.length,
            tokens,
          }
          expect(facts).toEqual(draft.subject === 'run' ? runFacts : providerFacts)
        }
      }),
      { numRuns: 300 },
    )
  })

  it('AC-13: a capped run’s summary names the tokens it stopped after, and a clean run gives nothing', () => {
    const clean: Report = {
      candidates: 1,
      alreadyAsked: 0,
      asked: ['p1'],
      proposed: [{ productId: 'p1', proposalId: 'x1', fields: ['seoTitle'] }],
      skipped: [],
      withheld: [],
      stopped: null,
      usage: { inputTokens: 700, outputTokens: 80, cacheReadTokens: 0, cacheWriteTokens: 0 },
      models: ['m'],
    }
    const capped: Report = { ...clean, stopped: 'token_cap' }
    const [run] = draftsOf(capped)

    expect(draftsOf(clean)).toEqual([])
    expect(run?.summary.includes(String(clean.usage.inputTokens + clean.usage.outputTokens))).toBe(
      true,
    )
  })
})
