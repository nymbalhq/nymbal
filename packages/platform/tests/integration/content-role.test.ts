import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import type { ProductSnapshot } from '@nymbalhq/types'
import { contentDrafts, runContentRole } from '../../src/roles/content.js'
import {
  NAMES,
  PROPOSER,
  ROLE_RULE,
  UPDATE_TOOL,
  contentAi,
  contentDeps,
  dayOf,
  goodCopy,
  json,
  keyOf,
  productIn,
  proposalRows,
  seedProduct,
  type ContentReply,
  type ContentRequest,
  type Draft,
  type RunReport,
} from '../support/content-role.js'
import { createKernel, type Kernel } from '../support/kernel.js'
import { openRaw, writeRaw, type RawReader } from '../support/raw.js'

// The content role run on a SQLite kernel with an in-process model: which products it asks about and in what order,
// what each request holds, what each answer becomes (a pending proposal, or a record the role's policy rejected), how
// a catalogue larger than one run is worked through, and where a run stops on its token cap or a provider failure.

const kernels: Kernel[] = []
const raws: RawReader[] = []

afterEach(async () => {
  for (const raw of raws.splice(0)) await raw.close()
  for (const k of kernels.splice(0)) await k.close()
})

async function store(): Promise<{ k: Kernel; raw: RawReader }> {
  const k = await createKernel({ dialect: 'sqlite' })
  kernels.push(k)
  const raw = openRaw(k.dialect, k.target)
  raws.push(raw)
  return { k, raw }
}

const ADMIN = { userId: 'admin-acceptance', roles: ['admin'] }

/** A model answering good copy for whichever of `products` a request names. */
const answering =
  (products: readonly ProductSnapshot[], replies: Record<string, ContentReply> = {}) =>
  (request: ContentRequest): ContentReply => {
    const product = productIn(request, products)
    if (product === undefined) return { text: 'Which product?' }
    return replies[product.name] ?? { text: json(goodCopy(product.name)) }
  }

const idsAsked = (requests: ContentRequest[], products: readonly ProductSnapshot[]) =>
  requests.map((r) => productIn(r, products)?.id ?? null)

const lower = (xs: readonly string[]) => xs.map((x) => x.toLowerCase())

const draftsOf = (report: RunReport): Draft[] => contentDrafts(report)

describe('AC-4: the products a run asks about, and in what order', () => {
  it('AC-4: of A and B (both blank, A older), C (a 160-character description, oldest), D (valid copy), E (draft) and F (archived), a run asks about A, B, C in that order and never D, E or F; with maxProducts 2 it asks A and B; candidates is 3 both times', async () => {
    const { k } = await store()
    const C = await seedProduct(k, {
      name: 'Cedar Tote',
      seoTitle: 'Cedar Tote for daily use',
      seoDescription: `Cedar Tote is roomy. ${'z'.repeat(200)}`.slice(0, 160),
      at: dayOf(0),
    })
    const A = await seedProduct(k, { name: 'Alder Tote', at: dayOf(1) })
    const B = await seedProduct(k, { name: 'Birch Tote', at: dayOf(2) })
    const D = await seedProduct(k, {
      name: 'Dogwood Tote',
      ...goodCopy('Dogwood Tote'),
      at: dayOf(3),
    })
    const E = await seedProduct(k, { name: 'Elm Tote', status: 'draft', at: dayOf(4) })
    const F = await seedProduct(k, { name: 'Fir Tote', status: 'archived', at: dayOf(5) })
    const all = [A, B, C, D, E, F]

    const model = contentAi(answering(all))
    const report: RunReport = await runContentRole(contentDeps(k, model.ai))

    expect(C.seoDescription.length).toBe(160)
    expect(idsAsked(model.requests, all)).toEqual([A.id, B.id, C.id])
    expect([report.asked, report.candidates]).toEqual([[A.id, B.id, C.id], 3])

    await k.app.relay.drain()
    await writeRaw(k.dialect, k.target, 'DELETE FROM proposals')
    const capped = contentAi(answering(all))
    const second: RunReport = await runContentRole(contentDeps(k, capped.ai, { maxProducts: 2 }))

    expect(idsAsked(capped.requests, all)).toEqual([A.id, B.id])
    expect([second.asked, second.candidates]).toEqual([[A.id, B.id], 3])
  })

  it('AC-4: a product whose only failing field is undeclared is no candidate: with fields [seoTitle] a valid title and a blank description asks nothing; with both fields declared it is asked', async () => {
    const { k } = await store()
    const G = await seedProduct(k, {
      name: 'Ginkgo Tote',
      seoTitle: goodCopy('Ginkgo Tote').seoTitle,
    })

    const titleOnly = contentAi(answering([G]))
    const narrow: RunReport = await runContentRole(
      contentDeps(k, titleOnly.ai, { fields: ['seoTitle'] }),
    )
    const both = contentAi(answering([G]))
    const wide: RunReport = await runContentRole(contentDeps(k, both.ai))

    expect([narrow.asked, narrow.candidates, titleOnly.requests.length]).toEqual([[], 0, 0])
    expect([wide.asked, idsAsked(both.requests, [G])]).toEqual([[G.id], [G.id]])
  })
})

describe('AC-5: what a request holds', () => {
  it('AC-5: the request holds the name, the description without markup, the short description, each variant’s name and option values, each metadata value, the current SEO fields and the role’s prompt, and offers no tools', async () => {
    const { k } = await store()
    const prompt = 'Write in a warm, plain voice and mention the Fenwick workshop by the river.'
    const P = await seedProduct(k, {
      name: 'Fenwick Satchel',
      description: '<p>Hand-stitched <strong>canvas</strong> body</p>',
      shortDescription: 'A satchel for the morning walk.',
      seoTitle: 'Satchel old headline',
      seoDescription: 'Brief note.',
      metadata: { material: 'waxed canvas', origin: 'Portugal', weightGrams: 840 },
      variants: [
        {
          name: 'Large Moss',
          options: [
            { name: 'Size', value: 'Grande' },
            { name: 'Colour', value: 'Mossgreen' },
          ],
        },
        {
          name: 'Small Clay',
          options: [
            { name: 'Size', value: 'Petite' },
            { name: 'Colour', value: 'Claybrown' },
          ],
        },
      ],
    })
    const model = contentAi(answering([P]))

    await runContentRole(contentDeps(k, model.ai, { prompt }))

    const [request] = model.requests
    const text = (request?.text ?? '').replace(/\s+/g, ' ')
    const needed = [
      'Fenwick Satchel',
      'Hand-stitched canvas body',
      'A satchel for the morning walk.',
      'Large Moss',
      'Small Clay',
      'Grande',
      'Mossgreen',
      'Petite',
      'Claybrown',
      'waxed canvas',
      'Portugal',
      '840',
      'Satchel old headline',
      'Brief note.',
      prompt,
    ]
    expect(model.requests.length).toBe(1)
    expect(needed.filter((n) => !text.includes(n))).toEqual([])
    expect([text.includes('<strong>'), request?.tools]).toEqual([false, []])
  })
})

describe('AC-9: an answer the checks refuse is recorded, rejected by the role’s policy', () => {
  it('AC-9: an unsupported claim, a validator finding, unreadable text and a key outside the fields are each withheld with their reason, a skip is recorded skipped, none is pending or approvable, and the product after them is still proposed', async () => {
    const { k, raw } = await store()
    const A = await seedProduct(k, {
      name: 'Alder Tote',
      description: 'Alder Tote is made of 100% cotton.',
      at: dayOf(0),
    })
    const B = await seedProduct(k, { name: 'Birch Tote', at: dayOf(1) })
    const C = await seedProduct(k, { name: 'Cedar Tote', at: dayOf(2) })
    const D = await seedProduct(k, { name: 'Dogwood Tote', at: dayOf(3) })
    const E = await seedProduct(k, { name: 'Elm Tote', at: dayOf(4) })
    const F = await seedProduct(k, { name: 'Fir Tote', at: dayOf(5) })
    const all = [A, B, C, D, E, F]
    const claim = {
      seoTitle: 'Alder Tote in organic cotton',
      seoDescription: goodCopy('Alder Tote').seoDescription,
    }
    const model = contentAi(
      answering(all, {
        'Alder Tote': { text: json(claim) },
        'Birch Tote': {
          text: json({
            seoTitle: 'Birch Tote, a roomy everyday bag with a zip pocket and sturdy handles',
            seoDescription: goodCopy('Birch Tote').seoDescription,
          }),
        },
        'Cedar Tote': { text: 'I would rather not answer that.' },
        'Dogwood Tote': {
          text: json({ seoTitle: goodCopy('Dogwood Tote').seoTitle, description: 'Rewritten.' }),
        },
        'Elm Tote': { text: json({ skip: true }) },
      }),
    )

    const report: RunReport = await runContentRole(contentDeps(k, model.ai))

    const withheld = new Map(report.withheld.map((w) => [w.productId, w]))
    expect(Object.fromEntries([...withheld].map(([id, w]) => [id, w.reason]))).toEqual({
      [A.id]: 'unsupported_claim',
      [B.id]: 'validation',
      [C.id]: 'unparsed',
      [D.id]: 'field_not_allowed',
    })
    expect(lower(withheld.get(A.id)!.detail)).toEqual(['organic'])
    expect(withheld.get(B.id)!.detail.includes('too_long')).toBe(true)
    expect(report.skipped.map((s) => s.productId)).toEqual([E.id])
    expect(report.proposed.map((p) => p.productId)).toEqual([F.id])
    expect(model.requests.length).toBe(all.length)

    const rows = new Map((await proposalRows(raw)).map((r) => [String(r.args['id']), r]))
    const decided = (id: string) => {
      const r = rows.get(id)!
      return [r.status, r.decidedByKind, r.decidedBy]
    }
    expect([A, B, C, D, E].map((p) => decided(p.id))).toEqual(
      [A, B, C, D, E].map(() => ['rejected', 'policy', ROLE_RULE]),
    )
    expect(decided(F.id)).toEqual(['pending', null, null])
    expect([A, C, D, E].map((p) => rows.get(p.id)!.reason)).toEqual([
      'withheld: unsupported claim (organic)',
      'withheld: unreadable answer',
      'withheld: field not allowed',
      'skipped: the model proposed no change',
    ])
    expect(rows.get(B.id)!.reason).toMatch(/^withheld: validation \(.*too_long.*\)$/)
    expect([rows.get(A.id)!.args, rows.get(C.id)!.args, rows.get(E.id)!.args]).toEqual([
      { id: A.id, ...claim },
      { id: C.id },
      { id: E.id },
    ])
    expect(report.withheld.map((w) => w.proposalId).sort()).toEqual(
      [A, B, C, D].map((p) => rows.get(p.id)!.id).sort(),
    )

    const recordA = rows.get(A.id)!
    await expect(k.services.proposals.approve(recordA.id, ADMIN)).rejects.toMatchObject({
      code: 'proposal.decided',
    })
    expect((await proposalRows(raw)).find((r) => r.id === recordA.id)?.status).toBe('rejected')
  })

  it('AC-9: an answered field is read trimmed: one equal to the stored copy but for surrounding whitespace is no change, and a proposal stores the trimmed copy', async () => {
    const { k, raw } = await store()
    const A = await seedProduct(k, {
      name: 'Alder Tote',
      seoTitle: goodCopy('Alder Tote').seoTitle,
      at: dayOf(0),
    })
    const B = await seedProduct(k, {
      name: 'Birch Tote',
      seoTitle: goodCopy('Birch Tote').seoTitle,
      at: dayOf(1),
    })
    const model = contentAi(
      answering([A, B], {
        'Alder Tote': {
          text: json({
            seoTitle: `${goodCopy('Alder Tote').seoTitle}\n`,
            seoDescription: `  ${goodCopy('Alder Tote').seoDescription}\n`,
          }),
        },
        'Birch Tote': { text: json({ seoTitle: ` ${goodCopy('Birch Tote').seoTitle}\n` }) },
      }),
    )

    const report: RunReport = await runContentRole(contentDeps(k, model.ai))

    expect(report.proposed.map((p) => [p.productId, p.fields])).toEqual([
      [A.id, ['seoDescription']],
    ])
    expect(report.skipped.map((s) => s.productId)).toEqual([B.id])
    expect(report.withheld).toEqual([])
    const rows = new Map((await proposalRows(raw)).map((r) => [String(r.args['id']), r]))
    expect([rows.get(A.id)!.status, rows.get(A.id)!.args]).toEqual([
      'pending',
      { id: A.id, seoDescription: goodCopy('Alder Tote').seoDescription },
    ])
    expect([rows.get(B.id)!.status, rows.get(B.id)!.args]).toEqual(['rejected', { id: B.id }])
  })
})

describe('AC-10: a catalogue larger than one run is worked through, each version asked once', () => {
  it('AC-10: of 25 failing products the first run asks the oldest 20 and the second the other 5 (candidates 5, alreadyAsked 20); a skipped or withheld product that changes is asked again, a rejected proposal’s product is not until it changes, an edited product whose proposal still waits is held back until it is decided, and another proposer’s pending proposal holds nothing back', async () => {
    const { k } = await store()
    const products: ProductSnapshot[] = []
    for (const [i, name] of NAMES.slice(0, 25).entries())
      products.push(await seedProduct(k, { name, at: dayOf(i) }))
    const ids = products.map((p) => p.id)
    const indexOf = (name: string) => NAMES.indexOf(name as (typeof NAMES)[number])
    const outcomeOf = (name: string): ContentReply => {
      const i = indexOf(name)
      if (i % 3 === 0) return { text: json({ skip: true }) }
      if (i % 3 === 2)
        return { text: json({ ...goodCopy(name), seoTitle: `${name} in organic wool` }) }
      return { text: json(goodCopy(name)) }
    }
    const script = (request: ContentRequest): ContentReply => {
      const product = productIn(request, products)
      return product === undefined ? { text: 'Which product?' } : outcomeOf(product.name)
    }
    const run = (): Promise<RunReport> =>
      runContentRole(contentDeps(k, contentAi(script).ai, { maxProducts: 20 }))

    const first = await run()
    const second = await run()

    expect([first.asked, first.candidates, first.alreadyAsked]).toEqual([ids.slice(0, 20), 25, 0])
    expect([second.asked, second.candidates, second.alreadyAsked]).toEqual([ids.slice(20), 5, 20])
    expect(first.skipped.length + first.withheld.length + first.proposed.length).toBe(20)

    const [p0, p1, p2, , p4, p5] = products
    const pendingOf = (p: ProductSnapshot) =>
      first.proposed.find((x) => x.productId === p.id)!.proposalId
    await k.services.product.update(p0!.id, { shortDescription: 'Skipped, then edited.' })
    await k.services.product.update(p2!.id, { shortDescription: 'Withheld, then edited.' })
    await k.services.proposals.reject(pendingOf(p1!), ADMIN, 'not this one')
    await k.services.product.update(p4!.id, {
      shortDescription: 'Edited while its proposal waits.',
    })
    await k.services.product.update(p5!.id, {
      shortDescription: 'Edited, with an admin idea waiting.',
    })
    await k.services.proposals.propose({
      tool: UPDATE_TOOL,
      command: 'product.update',
      args: { id: p5!.id, seoTitle: 'An admin idea' },
      idempotencyKey: `admin-idea-${p5!.id}`,
      caller: { auth: { userId: 'admin-other', roles: ['admin'] }, agent: { name: 'acceptance' } },
      correlationId: randomUUID(),
      at: new Date().toISOString(),
    })

    const third = await run()

    expect([third.asked, third.candidates, third.alreadyAsked]).toEqual([
      [p0!.id, p2!.id, p5!.id],
      3,
      22,
    ])

    await k.services.proposals.reject(pendingOf(p4!), ADMIN, 'decided at last')
    const fourth = await run()

    expect([fourth.asked, fourth.candidates, fourth.alreadyAsked]).toEqual([[p4!.id], 1, 24])
  })
})

describe('AC-11: the token cap', () => {
  it('AC-11: with usage crossing maxTokensPerRun on the second request, the run makes no third, reports token_cap with the two requests’ summed usage, keeps both records, and its run draft carries that sum as tokens', async () => {
    const { k, raw } = await store()
    const products = [
      await seedProduct(k, { name: 'Alder Tote', at: dayOf(0) }),
      await seedProduct(k, { name: 'Birch Tote', at: dayOf(1) }),
      await seedProduct(k, { name: 'Cedar Tote', at: dayOf(2) }),
    ]
    const model = contentAi((request) => ({
      ...answering(products)(request),
      usage: { inputTokens: 300, outputTokens: 300 },
    }))

    const report: RunReport = await runContentRole(
      contentDeps(k, model.ai, { maxTokensPerRun: 1000 }),
    )

    const sum = {
      inputTokens: model.usages.reduce((n, u) => n + u.inputTokens, 0),
      outputTokens: model.usages.reduce((n, u) => n + u.outputTokens, 0),
    }
    expect(model.requests.length).toBe(2)
    expect(report.stopped).toBe('token_cap')
    expect([report.usage.inputTokens, report.usage.outputTokens]).toEqual([
      sum.inputTokens,
      sum.outputTokens,
    ])
    expect((await proposalRows(raw)).map((r) => r.args['id'])).toEqual(
      idsAsked(model.requests, products),
    )
    expect(draftsOf(report).map((d) => [d.subject, d.facts['tokens']])).toEqual([
      ['run', sum.inputTokens + sum.outputTokens],
    ])
  })
})

describe('AC-12: a provider failure', () => {
  it('AC-12: a provider error on the second product stops the run: the first product’s proposal stays pending, no further product is asked, the run resolves with provider_failed, and its drafts are one provider warning', async () => {
    const { k, raw } = await store()
    const products = [
      await seedProduct(k, { name: 'Alder Tote', at: dayOf(0) }),
      await seedProduct(k, { name: 'Birch Tote', at: dayOf(1) }),
      await seedProduct(k, { name: 'Cedar Tote', at: dayOf(2) }),
    ]
    const model = contentAi((request) =>
      request.index === 1 ? { fail: true } : answering(products)(request),
    )

    const report: RunReport = await runContentRole(contentDeps(k, model.ai))

    const firstAsked = idsAsked(model.requests, products)[0]
    expect(model.requests.length).toBe(2)
    expect(report.stopped).toBe('provider_failed')
    expect(
      (await proposalRows(raw)).map((r) => [
        r.args['id'],
        r.status,
        r.proposerId,
        r.idempotencyKey,
      ]),
    ).toEqual([
      [firstAsked, 'pending', PROPOSER, keyOf(products.find((p) => p.id === firstAsked)!)],
    ])
    expect(draftsOf(report).map((d) => [d.subject, d.severity])).toEqual([['provider', 'warning']])
  })
})
