import fc from 'fast-check'
import { act, cleanup, screen, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { InsightView, ProposalView } from '@nymbalhq/types'
import { InboxPage } from '@/pages/InboxPage'
import { renderWithProviders } from '@/tests/render'
import { InsightBrief } from './InsightBrief'

// The night shift's brief at the top of the Inbox against a fake admin API (fetch stubbed): `GET /api/admin/insights`
// answers the server's open list, in the order the server gives it, and each dismiss POST is answered as the test says.

const AT = '2026-11-21T03:30:00.000Z'
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const SEVERITY_LABEL: Record<string, string> = {
  critical: 'Critical',
  warning: 'Warning',
  info: 'Info',
}
const JOB_LABEL: Record<string, string> = {
  'stock-runway': 'Stock',
  'zero-result-term': 'Search',
  demand: 'Orders',
  'refund-rate': 'Refunds',
  'operator-health': 'Store health',
  'role.content': 'role.content',
}
const KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/
const LOAD_ERROR = "The night shift's brief could not be loaded."
const ALREADY = 'This insight was already dismissed.'
const REFUSAL = 'Your session cannot dismiss insights.'

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

function insight(
  id: string,
  over: Partial<Pick<InsightView, 'job' | 'severity' | 'day' | 'summary'>> = {},
): InsightView {
  const day = over.day ?? '2026-11-21'
  return {
    id,
    job: over.job ?? 'stock-runway',
    subject: `variant:${id}`,
    day,
    dataDay: day,
    severity: over.severity ?? 'warning',
    summary: over.summary ?? `Summary for ${id}.`,
    facts: { stock: 5 },
    status: 'open',
    createdAt: AT,
    dismissedAt: null,
  }
}

type DismissOutcome = 'applied' | 'already' | 'refused'

interface FakeApi {
  posts: Array<{ id: string; key: string | null }>
  insightReads(): number
  /** Takes an insight off the server's list, as another admin's dismiss would, without the page knowing. */
  dismissElsewhere(id: string): void
}

/** The admin API with an insights list (or a failed read) and one dismiss outcome per POST, in order. */
function fakeApi(
  items: InsightView[] | 'fails',
  outcomes: DismissOutcome[] = [],
  proposals: ProposalView[] = [],
): FakeApi {
  let server = items === 'fails' ? [] : [...items]
  let reads = 0
  const posts: FakeApi['posts'] = []
  vi.stubGlobal('fetch', async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input instanceof Request ? input.url : input), 'http://localhost/')
    const method = (init.method ?? 'GET').toUpperCase()
    if (url.pathname === '/api/csrf') return json({ data: { token: 'csrf-tok' } })
    if (method === 'GET' && url.pathname === '/api/admin/insights') {
      reads += 1
      if (items === 'fails') {
        return json({ error: { code: 'internal', message: 'The store failed.' } }, 500)
      }
      return json({ data: { items: server } })
    }
    const dismiss = /^\/api\/admin\/insights\/([^/]+)\/dismiss$/.exec(url.pathname)
    if (method === 'POST' && dismiss) {
      const id = decodeURIComponent(dismiss[1]!)
      posts.push({ id, key: new Headers(init.headers).get('Idempotency-Key') })
      const outcome = outcomes[posts.length - 1] ?? 'applied'
      if (outcome === 'refused') {
        return json({ error: { code: 'auth.forbidden', message: REFUSAL } }, 403)
      }
      if (outcome === 'already') {
        return json({ error: { code: 'insight.dismissed', message: ALREADY } }, 409)
      }
      const found = server.find((i) => i.id === id)!
      server = server.filter((i) => i.id !== id)
      return json({ data: { ...found, status: 'dismissed', dismissedAt: AT } })
    }
    if (method === 'GET' && url.pathname === '/api/admin/proposals') {
      return json({ data: { items: proposals, nextCursor: null, pending: 0 } })
    }
    return json({ error: { code: 'not_mocked', message: url.pathname } }, 404)
  })
  return {
    posts,
    insightReads: () => reads,
    dismissElsewhere: (id) => {
      server = server.filter((i) => i.id !== id)
    },
  }
}

afterEach(() => vi.unstubAllGlobals())

const brief = () => within(screen.getByTestId('admin-inbox-brief'))

/** The ids of the brief's cards, in the order the page shows them. */
function cardIds(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-testid^="admin-inbox-insight-"]'))
    .map((el) => el.dataset['testid']!.slice('admin-inbox-insight-'.length))
    .filter((rest) => !rest.startsWith('severity-'))
}

const itemArb = fc.record({
  severity: fc.constantFrom('critical' as const, 'warning' as const, 'info' as const),
  job: fc.constantFrom(...Object.keys(JOB_LABEL)),
  month: fc.integer({ min: 1, max: 12 }),
  date: fc.integer({ min: 10, max: 28 }),
})

describe('AC-9: the brief shows what the list answers, as it answers it', () => {
  it("AC-9: property: one card per item in the answer's order, each with its severity label, its job's label (an unknown job its id), the night it is from and its summary", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(itemArb, { minLength: 1, maxLength: 6 }), async (drawn) => {
        const items = drawn.map((d, n) =>
          insight(`ins${n}`, {
            severity: d.severity,
            job: d.job,
            day: `2026-${String(d.month).padStart(2, '0')}-${d.date}`,
          }),
        )
        fakeApi(items)
        try {
          renderWithProviders(<InsightBrief />)
          await screen.findByTestId(`admin-inbox-insight-${items[0]!.id}`, undefined, {
            timeout: 5000,
          })

          expect(cardIds()).toEqual(items.map((i) => i.id))
          items.forEach((item, n) => {
            const card = screen.getByTestId(`admin-inbox-insight-${item.id}`)
            const text = card.textContent ?? ''
            const d = drawn[n]!
            expect(
              screen.getByTestId(`admin-inbox-insight-severity-${item.id}`).textContent,
            ).toBe(SEVERITY_LABEL[item.severity])
            expect(text, item.job).toContain(JOB_LABEL[item.job])
            expect(text).toContain(`Night of ${d.date} ${MONTHS[d.month - 1]} 2026`)
            expect(text).toContain(item.summary)
          })
        } finally {
          cleanup()
          vi.unstubAllGlobals()
        }
      }),
      { numRuns: 12 },
    )
  }, 60_000)

  it('AC-9: an empty answer shows "Nothing to report." and no card', async () => {
    const api = fakeApi([])
    renderWithProviders(<InsightBrief />)

    const empty = await screen.findByTestId('admin-inbox-brief-empty', undefined, { timeout: 5000 })

    expect(empty.textContent).toContain('Nothing to report.')
    expect(api.insightReads()).toBe(1)
    expect(cardIds()).toEqual([])
  })

  it("AC-9: a failed read shows the brief's error inside it, while the Inbox's proposal tabs and cards still render", async () => {
    const proposal: ProposalView = {
      id: 'p-1',
      tool: 'admin_products_create',
      title: 'admin.products.create',
      command: 'product.create',
      args: { name: 'Linen shirt' },
      handles: [],
      idempotencyKey: null,
      status: 'rejected',
      proposer: { userId: 'admin-1', agent: { name: 'nymbal-assistant' } },
      correlationId: 'corr-p-1',
      createdAt: AT,
      decision: { by: { kind: 'admin', id: 'admin-1' }, at: AT, reason: 'not now' },
    }
    fakeApi('fails', [], [proposal])
    renderWithProviders(<InboxPage />)

    await waitFor(() => expect(brief().getByText(LOAD_ERROR).textContent).toBe(LOAD_ERROR), {
      timeout: 5000,
    })
    const row = await screen.findByTestId('admin-inbox-row-p-1', undefined, { timeout: 5000 })

    expect(row.textContent).toContain('product.create')
    expect(screen.getByTestId('admin-inbox-tab-pending').textContent).toBe('Pending')
    expect(cardIds()).toEqual([])
  })
})

/** Clicks Dismiss `k` times before the brief can re-render. */
async function clickDismiss(id: string, k: number): Promise<HTMLButtonElement> {
  const button = (await screen.findByTestId(`admin-inbox-dismiss-${id}`, undefined, {
    timeout: 5000,
  })) as HTMLButtonElement
  act(() => {
    for (let i = 0; i < k; i += 1) button.click()
  })
  return button
}

describe('AC-11: Dismiss on a card', () => {
  it('AC-11: property: k rapid clicks send one POST with an Idempotency-Key, and the card leaves once the list is read again', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 2, max: 5 }), async (k) => {
        const items = [insight('ins-a', { severity: 'critical' }), insight('ins-b')]
        const api = fakeApi(items, ['applied'])
        try {
          renderWithProviders(<InsightBrief />)
          await screen.findByTestId('admin-inbox-insight-ins-a', undefined, { timeout: 5000 })
          const readsBefore = api.insightReads()

          await clickDismiss('ins-a', k)
          await waitFor(() => expect(cardIds()).toEqual(['ins-b']), { timeout: 5000 })

          expect(api.posts.map((p) => p.id)).toEqual(['ins-a'])
          expect(api.posts[0]!.key).toMatch(KEY_PATTERN)
          expect(api.insightReads()).toBeGreaterThan(readsBefore)
        } finally {
          cleanup()
          vi.unstubAllGlobals()
        }
      }),
      { numRuns: 4 },
    )
  }, 60_000)

  it('AC-11: a 409 insight.dismissed (another admin got there first) takes the card away with no error shown', async () => {
    const api = fakeApi([insight('ins-a'), insight('ins-b')], ['already'])
    renderWithProviders(<InsightBrief />)
    await screen.findByTestId('admin-inbox-insight-ins-a', undefined, { timeout: 5000 })
    api.dismissElsewhere('ins-a')

    await clickDismiss('ins-a', 1)
    await waitFor(() => expect(cardIds()).toEqual(['ins-b']), { timeout: 5000 })

    expect(api.posts.map((p) => p.id)).toEqual(['ins-a'])
    expect(screen.queryByText(ALREADY)).toBeNull()
  })

  it('AC-11: any other refusal shows its message on the card and Dismiss works again', async () => {
    const api = fakeApi([insight('ins-a')], ['refused', 'applied'])
    renderWithProviders(<InsightBrief />)
    await screen.findByTestId('admin-inbox-insight-ins-a', undefined, { timeout: 5000 })

    const button = await clickDismiss('ins-a', 1)
    const card = screen.getByTestId('admin-inbox-insight-ins-a')
    await waitFor(() => expect(within(card).getByText(REFUSAL).textContent).toBe(REFUSAL), {
      timeout: 5000,
    })
    await waitFor(() => expect(button.disabled).toBe(false))
    await clickDismiss('ins-a', 1)
    await waitFor(() => expect(cardIds()).toEqual([]), { timeout: 5000 })

    expect(api.posts.map((p) => p.id)).toEqual(['ins-a', 'ins-a'])
  })
})
