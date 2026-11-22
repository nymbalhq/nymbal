import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ProductSnapshot, ProposalView } from '@nymbalhq/types'
import { runContentRole } from '../../src/roles/content.js'
import { adminSession, type AdminSession } from '../support/audit-http.js'
import {
  AGENT,
  PROPOSER,
  UPDATE_TOOL,
  contentAi,
  contentDeps,
  dayOf,
  goodCopy,
  json,
  keyOf,
  productIn,
  seedProduct,
  type ContentReply,
  type ContentRequest,
} from '../support/content-role.js'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { createKernel, type Kernel } from '../support/kernel.js'
import { committedAudit } from '../support/mcp.js'
import { openRaw, type RawReader } from '../support/raw.js'

// The role's proposals in the merchant's Inbox over HTTP: a pending row an admin can list, read with its preview,
// approve once (the storefront then serves the copy) or reject (nothing changes). Until then the role has changed no
// product, document or audit entry.

let k: Kernel
let served: ServedKernel
let admin: AdminSession
let raw: RawReader

beforeAll(async () => {
  k = await createKernel({ dialect: 'sqlite' })
  served = await serveKernel(k)
  admin = await adminSession(k, served.baseUrl)
  raw = openRaw(k.dialect, k.target)
}, 60_000)

afterAll(async () => {
  await raw?.close()
  await served?.stop()
})

function scriptFor(
  products: readonly ProductSnapshot[],
  replies: Record<string, ContentReply> = {},
) {
  return (request: ContentRequest): ContentReply => {
    const product = productIn(request, products)
    if (product === undefined) return { text: 'Which product?' }
    return replies[product.name] ?? { text: json(goodCopy(product.name)) }
  }
}

/** What a second connection reads of a product's row. */
const rowOf = (id: string) =>
  raw.one<Record<string, unknown>>(
    'SELECT name, description, status, seo_title, seo_description, updated_at FROM products WHERE id = ?',
    [id],
  )

async function docOf(slug: string): Promise<Record<string, unknown>> {
  const answer = await admin.send<Record<string, unknown>>('GET', `/api/products/${slug}`)
  return answer.body.data ?? { status: answer.status }
}

async function pending(): Promise<ProposalView[]> {
  const answer = await admin.send<{ items: ProposalView[] }>(
    'GET',
    '/api/admin/proposals?status=pending&limit=100',
  )
  return answer.body.data?.items ?? []
}

describe('AC-6: a valid answer waits in the Inbox as the role’s proposal', () => {
  it('AC-6: one pending proposal per product: tool admin_products_update, command product.update, args of the id and only the answered fields, agent nymbal-content, proposer role:content, key content.<id>.<updatedAt ms>; the list shows it without a preview and the single read previews SEO title and SEO description current beside proposed; no product row, document or audit entry changed', async () => {
    const A = await seedProduct(k, { name: 'Alder Tote', at: dayOf(0) })
    const B = await seedProduct(k, { name: 'Birch Tote', at: dayOf(1) })
    const titleOnly = { seoTitle: goodCopy('Birch Tote').seoTitle }
    const before = {
      rows: [await rowOf(A.id), await rowOf(B.id)],
      docs: [await docOf(A.slug), await docOf(B.slug)],
      audit: await raw.count('audit_entries'),
    }
    const model = contentAi(scriptFor([A, B], { 'Birch Tote': { text: json(titleOnly) } }))

    await runContentRole(contentDeps(k, model.ai))

    const listed = (await pending()).filter((v) => v.args['id'] === A.id || v.args['id'] === B.id)
    const shape = (v: ProposalView) => ({
      tool: v.tool,
      command: v.command,
      args: v.args,
      proposer: v.proposer,
      idempotencyKey: v.idempotencyKey,
      status: v.status,
    })
    const expected = (p: ProductSnapshot, fields: Record<string, string>) => ({
      tool: UPDATE_TOOL,
      command: 'product.update',
      args: { id: p.id, ...fields },
      proposer: { userId: PROPOSER, agent: { name: AGENT } },
      idempotencyKey: keyOf(p),
      status: 'pending',
    })
    expect(
      listed.map(shape).sort((x, y) => String(x.args.id).localeCompare(String(y.args.id))),
    ).toEqual(
      [expected(A, goodCopy('Alder Tote')), expected(B, titleOnly)].sort((x, y) =>
        x.args.id.localeCompare(y.args.id),
      ),
    )
    expect(listed.filter((v) => v.preview !== undefined)).toEqual([])

    const single = await admin.send<ProposalView>(
      'GET',
      `/api/admin/proposals/${listed.find((v) => v.args['id'] === A.id)!.id}`,
    )
    const seo = (single.body.data?.preview?.changes ?? [])
      .filter((c) => c.label === 'SEO title' || c.label === 'SEO description')
      .map((c) => [c.label, c.current, c.proposed])
    expect(seo).toEqual([
      ['SEO title', A.seoTitle, goodCopy('Alder Tote').seoTitle],
      ['SEO description', A.seoDescription, goodCopy('Alder Tote').seoDescription],
    ])

    expect({
      rows: [await rowOf(A.id), await rowOf(B.id)],
      docs: [await docOf(A.slug), await docOf(B.slug)],
      audit: await raw.count('audit_entries'),
    }).toEqual(before)
  })
})

describe('AC-16: an approved role proposal reaches the storefront', () => {
  it('AC-16: approving applies it once, one product.update audit entry by the approving admin, and the storefront document then serves the proposed seoTitle and seoDescription; a second approval is refused; rejecting another leaves its product and document as they were', async () => {
    const C = await seedProduct(k, { name: 'Cedar Tote', at: dayOf(2) })
    const D = await seedProduct(k, { name: 'Dogwood Tote', at: dayOf(3) })
    await runContentRole(contentDeps(k, contentAi(scriptFor([C, D])).ai))
    const proposalOf = async (p: ProductSnapshot) =>
      (await pending()).find((v) => v.args['id'] === p.id)!.id
    const toApprove = await proposalOf(C)
    const toReject = await proposalOf(D)
    const rejectedBefore = { row: await rowOf(D.id), doc: await docOf(D.slug) }

    const approved = await admin.send<ProposalView>(
      'POST',
      `/api/admin/proposals/${toApprove}/approve`,
    )
    const again = await admin.send<ProposalView>(
      'POST',
      `/api/admin/proposals/${toApprove}/approve`,
    )
    const rejected = await admin.send<ProposalView>(
      'POST',
      `/api/admin/proposals/${toReject}/reject`,
      {
        reason: 'not this copy',
      },
    )

    const copy = goodCopy('Cedar Tote')
    await vi.waitFor(async () => expect((await docOf(C.slug))['seoTitle']).toBe(copy.seoTitle), {
      timeout: 10_000,
    })
    const doc = await docOf(C.slug)
    const updates = committedAudit(k.target).filter(
      (e) => e.command === 'product.update' && e.subjectIds.includes(C.id),
    )
    expect([
      approved.body.data?.status,
      again.status,
      again.body.error?.code,
      rejected.body.data?.status,
    ]).toEqual(['applied', 409, 'proposal.decided', 'rejected'])
    expect(updates.map((e) => [e.actorId, e.outcome])).toEqual([[admin.userId, 'applied']])
    expect([doc['seoTitle'], doc['seoDescription']]).toEqual([copy.seoTitle, copy.seoDescription])
    expect({ row: await rowOf(D.id), doc: await docOf(D.slug) }).toEqual(rejectedBefore)
  })
})
