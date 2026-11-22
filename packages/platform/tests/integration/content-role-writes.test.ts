import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { NymbalConfig } from '@nymbalhq/config'
import type { ProductSnapshot } from '@nymbalhq/types'
import { runContentRole } from '../../src/roles/content.js'
import {
  NAMES,
  ROLE_RULE,
  SEO_FIELDS,
  contentAi,
  contentDeps,
  goodCopy,
  json,
  productIn,
  proposalRows,
  seedProduct,
  type ContentReply,
} from '../support/content-role.js'
import { createKernel, type Kernel } from '../support/kernel.js'
import { eventRows, maxSeq } from '../support/outbox.js'
import { openRaw, writeRaw, type RawReader } from '../support/raw.js'

// No direct writes: whatever the model answers, and whatever the store's agent policy says, a content run changes no
// product, variant, order or customer row and writes no audit row; its only writes are proposals, each pending or
// rejected by the role's own rule, each for a product of its batch and holding only the role's declared fields.

const POLICIES: Array<{
  label: string
  agents: (a: NymbalConfig['agents']) => NymbalConfig['agents']
}> = [
  { label: 'autoApprove: []', agents: (a) => ({ ...a, autoApprove: [] }) },
  {
    label: "autoApprove: ['product.update']",
    agents: (a) => ({ ...a, autoApprove: ['product.update'] }),
  },
  { label: "mcp.writes: 'apply'", agents: (a) => ({ ...a, mcp: { ...a.mcp, writes: 'apply' } }) },
]

interface Side {
  k: Kernel
  raw: RawReader
  /** An active product outside every batch, with copy that passes, for answers that name another product. */
  outsider: ProductSnapshot
}

const sides: Side[] = []

beforeAll(async () => {
  for (const policy of POLICIES) {
    const k = await createKernel({
      dialect: 'sqlite',
      configure: (config) => ({ ...config, agents: policy.agents(config.agents) }),
    })
    const outsider = await seedProduct(k, { name: 'Hemlock Tote', ...goodCopy('Hemlock Tote') })
    sides.push({ k, raw: openRaw(k.dialect, k.target), outsider })
  }
}, 60_000)

afterAll(async () => {
  for (const side of sides.splice(0)) {
    await side.raw.close()
    await side.k.close()
  }
})

type Shape =
  | { kind: 'text'; text: string }
  | { kind: 'good' }
  | { kind: 'skip' }
  | { kind: 'extra'; keys: string[] }
  | { kind: 'other-product' }
  | { kind: 'tool-shaped' }
  | { kind: 'tool-call' }
  | { kind: 'claim' }

const shapeArb: fc.Arbitrary<Shape> = fc.oneof(
  fc.string({ maxLength: 200 }).map((text): Shape => ({ kind: 'text', text })),
  fc.constant<Shape>({ kind: 'good' }),
  fc.constant<Shape>({ kind: 'skip' }),
  fc
    .subarray(['name', 'status', 'description', 'variants', 'metadata', 'media', 'categoryIds'], {
      minLength: 1,
    })
    .map((keys): Shape => ({ kind: 'extra', keys })),
  fc.constant<Shape>({ kind: 'other-product' }),
  fc.constant<Shape>({ kind: 'tool-shaped' }),
  fc.constant<Shape>({ kind: 'tool-call' }),
  fc.constant<Shape>({ kind: 'claim' }),
)

const EXTRA: Record<string, unknown> = {
  name: 'Renamed by the model',
  status: 'archived',
  description: 'Rewritten by the model.',
  variants: [{ priceMinor: 1, stock: 0 }],
  metadata: { origin: 'Italy' },
  media: [],
  categoryIds: [],
}

function replyOf(shape: Shape, name: string, outsiderId: string): ContentReply {
  const copy = goodCopy(name)
  switch (shape.kind) {
    case 'text':
      return { text: shape.text }
    case 'good':
      return { text: json(copy) }
    case 'skip':
      return { text: json({ skip: true }) }
    case 'extra':
      return {
        text: json({ ...copy, ...Object.fromEntries(shape.keys.map((key) => [key, EXTRA[key]])) }),
      }
    case 'other-product':
      return { text: json({ id: outsiderId, ...copy }) }
    case 'tool-shaped':
      return {
        text: `<tool_call>${json({ name: 'admin_products_update', arguments: { id: outsiderId, status: 'archived', seoTitle: copy.seoTitle } })}</tool_call>`,
      }
    case 'tool-call':
      return {
        text: json(copy),
        calls: [
          {
            name: 'admin_products_update',
            args: { id: outsiderId, status: 'archived', name: 'Taken over' },
          },
        ],
      }
    case 'claim':
      return { text: json({ ...copy, seoTitle: `${name} in organic Italian silk` }) }
  }
}

const ALLOWED_EVENTS = new Set(['proposal.created.v1', 'proposal.rejected.v1'])
const GUARDED = ['products', 'variants', 'orders', 'customers'] as const

async function guardedRows(raw: RawReader): Promise<string> {
  const tables: Record<string, unknown> = {}
  for (const table of GUARDED) tables[table] = await raw.rows(`SELECT * FROM ${table} ORDER BY id`)
  return JSON.stringify(tables)
}

describe('AC-7: a content run makes no direct write, under any agent policy', () => {
  it("AC-7: property: for any model replies (any text, JSON with extra keys, another product's id, text or calls shaped like a tool call) under autoApprove [], autoApprove ['product.update'] and mcp.writes 'apply', no product, variant, order, customer or audit row changes, only proposal events are logged, and each new proposal is pending or rejected by agents.roles.content, holds only id and declared fields, for a product of the batch", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: POLICIES.length - 1 }),
        fc.subarray([...SEO_FIELDS], { minLength: 1 }),
        fc.array(shapeArb, { minLength: 1, maxLength: 3 }),
        async (policy, fields, shapes) => {
          const { k, raw, outsider } = sides[policy]!
          await k.app.relay.drain()
          await writeRaw(
            k.dialect,
            k.target,
            "UPDATE products SET status = 'archived' WHERE id <> ?",
            [outsider.id],
          )
          const batch: ProductSnapshot[] = []
          for (const name of NAMES.slice(0, shapes.length))
            batch.push(await seedProduct(k, { name }))
          await k.app.relay.drain()

          const before = {
            rows: await guardedRows(raw),
            audit: await raw.count('audit_entries'),
            seq: await maxSeq(raw),
            proposals: new Set((await proposalRows(raw)).map((r) => r.id)),
          }
          const model = contentAi((request) => {
            const product = productIn(request, batch)
            if (product === undefined) return { text: json({ skip: true }) }
            return replyOf(shapes[batch.indexOf(product)]!, product.name, outsider.id)
          })

          await runContentRole(contentDeps(k, model.ai, { fields }))
          await k.app.relay.drain()

          const events = await eventRows(raw, 'seq > ?', [before.seq])
          const added = (await proposalRows(raw)).filter((r) => !before.proposals.has(r.id))
          const batchIds = new Set(batch.map((p) => p.id))
          expect(await guardedRows(raw)).toBe(before.rows)
          expect(await raw.count('audit_entries')).toBe(before.audit)
          expect(events.map((e) => e.type).filter((t) => !ALLOWED_EVENTS.has(t))).toEqual([])
          expect(added.length).toBe(model.requests.length)
          for (const row of added) {
            const decided =
              row.status === 'pending'
                ? row.decidedByKind === null
                : row.status === 'rejected' &&
                  row.decidedByKind === 'policy' &&
                  row.decidedBy === ROLE_RULE
            expect({ status: row.status, decided }).toEqual({ status: row.status, decided: true })
            expect(
              Object.keys(row.args).filter((key) => key !== 'id' && !fields.includes(key as never)),
            ).toEqual([])
            expect(batchIds.has(String(row.args['id']))).toBe(true)
          }
        },
      ),
      { numRuns: 36 },
    )
  }, 180_000)
})
