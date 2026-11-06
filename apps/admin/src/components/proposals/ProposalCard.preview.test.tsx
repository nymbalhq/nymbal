import { afterEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import fc from 'fast-check'
import type { ProposalView } from '@nymbalhq/types'
import { renderWithProviders } from '@/tests/render'
import { formatMoney } from '@/lib/money'
import { AssistantProposalCard } from '@/components/assistant/AssistantProposalCard'
import { ProposalCard } from './ProposalCard'

// The inbox card and the assistant panel's card of a pending proposal read `GET /api/admin/proposals/:id` and show
// what the write acts on and what it changes, `<label>: <current> → <proposed>`: money through formatMoney in the
// preview's currency, counts for a collection. The arguments stay listed. A command the server previews nothing for
// sends no such read. The API is faked at fetch; the cards and their hooks are the real ones.

interface Change {
  label: string
  kind: 'value' | 'money' | 'collection'
  current: string | number | null
  proposed: string | number | null
  changed?: boolean
}
interface Preview {
  target: { kind: 'product' | 'variant' | 'order'; id: string; label: string } | null
  changes: Change[]
  currency: string
}

const AT = '2026-11-05T10:00:00.000Z'

function proposal(
  id: string,
  command: string,
  tool: string,
  args: Record<string, unknown>,
): ProposalView {
  return {
    id,
    tool,
    title: tool.replaceAll('_', '.'),
    command,
    args,
    handles: [],
    idempotencyKey: null,
    status: 'pending',
    proposer: { userId: 'admin-1', agent: { name: 'nymbal-assistant' } },
    correlationId: `${id}-turn.1`,
    createdAt: AT,
  }
}

/** `GET /api/admin/proposals/:id` answering each proposal with its preview (none for the ids without one). */
function fakeApi(views: Array<{ view: ProposalView; preview?: Preview }>) {
  const reads = new Map<string, number>()
  vi.stubGlobal('fetch', async (input: string | URL | Request) => {
    const url = new URL(String(input instanceof Request ? input.url : input), 'http://localhost/')
    const id = /^\/api\/admin\/proposals\/([^/]+)$/.exec(url.pathname)?.[1]
    const found = views.find((v) => v.view.id === id)
    if (found !== undefined) {
      reads.set(found.view.id, (reads.get(found.view.id) ?? 0) + 1)
      const data =
        found.preview === undefined ? found.view : { ...found.view, preview: found.preview }
      return new Response(JSON.stringify({ data }), { status: 200 })
    }
    return new Response(JSON.stringify({ error: { code: 'not_mocked', message: url.pathname } }), {
      status: 404,
    })
  })
  return (id: string) => reads.get(id) ?? 0
}

afterEach(() => {
  vi.unstubAllGlobals()
})

type Card = 'inbox' | 'assistant'

function renderCards(card: Card, views: ProposalView[]) {
  return renderWithProviders(
    <div>
      {views.map((view) =>
        card === 'inbox' ? (
          <ProposalCard key={view.id} proposal={view} me="admin-1" onReject={() => undefined} />
        ) : (
          <AssistantProposalCard key={view.id} proposal={view} />
        ),
      )}
    </div>,
  )
}

const text = (el: Element) => (el.textContent ?? '').replace(/\s+/g, ' ').trim()
const norm = (s: string) => s.replace(/\s+/g, ' ').trim()

/** The change lines a card shows for `id`, once there are `count` of them. */
async function changeLines(card: Card, id: string, count: number): Promise<string[]> {
  await waitFor(() =>
    expect(screen.queryAllByTestId(`admin-${card}-change-${id}`).length).toBe(count),
  )
  return screen.getAllByTestId(`admin-${card}-change-${id}`).map(text)
}

const moneyShown = (minor: number | null, currency: string) =>
  minor === null ? 'none' : formatMoney(minor, currency)

const LONG = 'A '.repeat(100).trim() + ' long description'

const CASES: Array<{
  command: string
  tool: string
  args: Record<string, unknown>
  preview: Preview
  lines: string[]
}> = [
  {
    command: 'product.update',
    tool: 'admin_products_update',
    args: {
      id: 'prod-1',
      name: 'Stoneware Mug',
      description: LONG,
      media: [{ url: 'a', altText: '', position: 0 }],
      variants: [{ id: 'var-1', priceMinor: 2100, compareAtPriceMinor: 3000 }],
    },
    preview: {
      target: { kind: 'product', id: 'prod-1', label: 'Ceramic Mug' },
      changes: [
        { label: 'Name', kind: 'value', current: 'Ceramic Mug', proposed: 'Stoneware Mug' },
        { label: 'Description', kind: 'value', current: 'Short.', proposed: LONG },
        { label: 'Media', kind: 'collection', current: 3, proposed: 2, changed: true },
        { label: 'Categories', kind: 'collection', current: 1, proposed: 1, changed: false },
        { label: 'Price of Default', kind: 'money', current: 1500, proposed: 2100 },
        { label: 'Compare-at price of Default', kind: 'money', current: null, proposed: 3000 },
      ],
      currency: 'GBP',
    },
    lines: [
      'Name: Ceramic Mug → Stoneware Mug',
      `Description: Short. → ${LONG.slice(0, 120)}…`,
      'Media: 3 → 2 items, changed',
      'Categories: 1 → 1 items',
      'Price of Default: £15.00 → £21.00',
      'Compare-at price of Default: none → £30.00',
    ],
  },
  {
    command: 'inventory.adjust',
    tool: 'admin_inventory_adjust',
    args: { variantId: 'var-9', delta: 40, reason: 'manual' },
    preview: {
      target: { kind: 'variant', id: 'var-9', label: 'Runner Socks, Default (SOCK-1)' },
      changes: [{ label: 'Stock', kind: 'value', current: 12, proposed: 52 }],
      currency: 'GBP',
    },
    lines: ['Stock: 12 → 52'],
  },
  {
    command: 'order.refund',
    tool: 'admin_orders_refund',
    args: { id: 'ord-1', amountMinor: 2500 },
    preview: {
      target: { kind: 'order', id: 'ord-1', label: '#1042' },
      changes: [{ label: 'Refunded', kind: 'money', current: 0, proposed: 2500 }],
      currency: 'GBP',
    },
    lines: ['Refunded: £0.00 → £25.00'],
  },
  {
    command: 'order.cancel',
    tool: 'admin_orders_cancel',
    args: { id: 'ord-2' },
    preview: {
      target: { kind: 'order', id: 'ord-2', label: '#1043' },
      changes: [{ label: 'Status', kind: 'value', current: 'pending', proposed: 'cancelled' }],
      currency: 'GBP',
    },
    lines: ['Status: pending → cancelled'],
  },
]

describe('AC-12: a pending proposal’s card shows what it acts on and what it changes', () => {
  for (const card of ['inbox', 'assistant'] as const) {
    it.each(CASES)(
      `AC-12: the ${card} card of a pending $command reads its proposal once and shows the target’s label and each change as "<label>: <current> → <proposed>", the arguments still listed`,
      async ({ command, tool, args, preview, lines }) => {
        const id = `p-${command}`
        const view = proposal(id, command, tool, args)
        const readsOf = fakeApi([{ view, preview }])

        renderCards(card, [view])

        expect(await changeLines(card, id, lines.length)).toEqual(lines.map(norm))
        expect(text(screen.getByTestId(`admin-${card}-target-${id}`))).toContain(
          preview.target!.label,
        )
        expect(readsOf(id)).toBe(1)
        // The arguments stay listed below: every key, and every text value whole.
        const shown = text(
          screen.getByTestId(
            card === 'inbox' ? `admin-inbox-row-${id}` : `admin-assistant-proposal-${id}`,
          ),
        )
        const listed = Object.entries(args).flatMap(([key, value]) =>
          typeof value === 'string' ? [key, norm(value)] : [key],
        )
        expect(listed.filter((part) => !shown.includes(part))).toEqual([])
      },
    )

    it(`AC-12: property: the ${card} card shows any price and refund through formatMoney in the preview’s currency, dividing minor units`, async () => {
      await fc.assert(
        fc.asyncProperty(
          fc.constantFrom('GBP', 'EUR', 'USD'),
          fc.nat(10_000_000),
          fc.nat(10_000_000),
          fc.nat(10_000_000),
          async (currency, current, proposed, refunded) => {
            const id = `p-money-${currency}-${current}-${proposed}-${refunded}`
            const view = proposal(id, 'product.update', 'admin_products_update', {
              id: 'prod-1',
              variants: [{ id: 'var-1', priceMinor: proposed }],
            })
            const refundId = `${id}-refund`
            const refund = proposal(refundId, 'order.refund', 'admin_orders_refund', {
              id: 'ord-1',
              amountMinor: refunded,
            })
            fakeApi([
              {
                view,
                preview: {
                  target: { kind: 'product', id: 'prod-1', label: 'Mug' },
                  changes: [{ label: 'Price of Large', kind: 'money', current, proposed }],
                  currency,
                },
              },
              {
                view: refund,
                preview: {
                  target: { kind: 'order', id: 'ord-1', label: '#7' },
                  changes: [
                    { label: 'Refunded', kind: 'money', current, proposed: current + refunded },
                  ],
                  currency,
                },
              },
            ])
            const rendered = renderCards(card, [view, refund])
            try {
              expect(await changeLines(card, id, 1)).toEqual([
                norm(
                  `Price of Large: ${moneyShown(current, currency)} → ${moneyShown(proposed, currency)}`,
                ),
              ])
              expect(await changeLines(card, refundId, 1)).toEqual([
                norm(
                  `Refunded: ${moneyShown(current, currency)} → ${moneyShown(current + refunded, currency)}`,
                ),
              ])
            } finally {
              rendered.unmount()
              vi.unstubAllGlobals()
            }
          },
        ),
        // A failing run waits out its lookups; one is enough to read, so it is not shrunk.
        { numRuns: 12, endOnFailure: true },
      )
    }, 30_000)

    it(`AC-12: the ${card} card of a proposal whose target is gone reads "Not found: <id>"; a pending product.create beside it sends no read of its own and shows no target or change`, async () => {
      const gone = proposal('p-gone', 'order.cancel', 'admin_orders_cancel', { id: 'ord-missing' })
      const create = proposal('p-create', 'product.create', 'admin_products_create', {
        slug: 'linen-apron',
        name: 'Linen Apron',
      })
      const readsOf = fakeApi([
        { view: gone, preview: { target: null, changes: [], currency: 'GBP' } },
        { view: create },
      ])

      renderCards(card, [gone, create])

      await waitFor(() =>
        expect(text(screen.getByTestId(`admin-${card}-target-p-gone`))).toBe(
          'Not found: ord-missing',
        ),
      )
      expect([readsOf('p-gone'), readsOf('p-create')]).toEqual([1, 0])
      expect(screen.queryAllByTestId(/^admin-(inbox|assistant)-(target|change)-p-create$/)).toEqual(
        [],
      )
    })
  }
})
