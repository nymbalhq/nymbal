import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import fc from 'fast-check'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AdminReview, ReviewModerationStatus } from '@nymbalhq/types'
import { renderWithProviders } from '@/tests/render'
import { ReviewsPage } from './ReviewsPage'

// The reviews moderation page against a fake admin API (fetch stubbed): `GET /api/admin/reviews` answers the reviews
// of the status asked for (pending when none is), and a moderate POST moves its review to the decided status, or is
// refused, thrown or held open as the test says.

const AT = '2026-11-20T10:00:00.000Z'
const KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/

type Decision = 'approved' | 'rejected'
type PostAnswer =
  | { kind: 'applied' }
  | { kind: 'refused'; status: number; code: string; message: string }
  | { kind: 'throws' }

interface Sent {
  method: string
  path: string
  status: string | null
  body: unknown
  key: string | null
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

function review(over: Partial<AdminReview> & Pick<AdminReview, 'id'>): AdminReview {
  return {
    productId: `p-${over.id}`,
    customerId: `c-${over.id}`,
    orderId: null,
    rating: 3,
    title: `Title of ${over.id}`,
    body: `Body of ${over.id}.`,
    moderationStatus: 'pending',
    submittedAt: AT,
    moderatedAt: null,
    moderatedBy: null,
    productName: `Product ${over.id}`,
    productSlug: `product-${over.id}`,
    ...over,
  }
}

const VERIFIED = review({
  id: 'rv-verified',
  productId: 'p-shirt',
  productName: 'Linen Shirt',
  productSlug: 'linen-shirt',
  orderId: 'o-1042',
  rating: 4,
  title: 'Soft and cool',
  body: 'Worn all summer. The linen softened after a few washes and kept its shape; the collar still sits flat.',
})

const ORPHAN = review({
  id: 'rv-orphan',
  productId: 'p-gone',
  productName: null,
  productSlug: null,
  orderId: null,
  rating: 2,
  title: 'Faded fast',
  body: 'The colour ran in the first wash and I would not buy it again.',
})

/**
 * The admin API holding `seed` by status. Each moderate POST takes the next of `answers` (applied when none is left);
 * while `holding`, every POST waits for `release` before it is answered.
 */
function fakeApi(
  seed: Partial<Record<ReviewModerationStatus, AdminReview[]>>,
  opts: { answers?: PostAnswer[]; holding?: boolean } = {},
) {
  const lists: Record<ReviewModerationStatus, AdminReview[]> = {
    pending: [...(seed.pending ?? [])],
    approved: [...(seed.approved ?? [])],
    rejected: [...(seed.rejected ?? [])],
  }
  const sent: Sent[] = []
  const held: Array<() => void> = []
  let posted = 0
  let holding = opts.holding ?? false
  vi.stubGlobal('fetch', async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(
      String(input instanceof Request ? input.url : input),
      'http://localhost/admin/',
    )
    const method = (init.method ?? 'GET').toUpperCase()
    const body: unknown = typeof init.body === 'string' ? JSON.parse(init.body) : undefined
    sent.push({
      method,
      path: url.pathname,
      status: url.searchParams.get('status'),
      body,
      key: new Headers(init.headers).get('idempotency-key'),
    })
    if (url.pathname === '/api/csrf') return json({ data: { token: 'csrf-tok' } })
    if (method === 'GET' && url.pathname === '/api/admin/reviews') {
      const status = (url.searchParams.get('status') ?? 'pending') as ReviewModerationStatus
      return json({ data: lists[status] ?? [] })
    }
    const moderate = /^\/api\/admin\/reviews\/([^/]+)\/moderate$/.exec(url.pathname)
    if (method === 'POST' && moderate) {
      const id = decodeURIComponent(moderate[1]!)
      const answer = opts.answers?.[posted] ?? { kind: 'applied' }
      posted += 1
      if (holding) await new Promise<void>((resolve) => held.push(resolve))
      if (answer.kind === 'throws') throw new TypeError('Failed to fetch')
      if (answer.kind === 'refused') {
        return json({ error: { code: answer.code, message: answer.message } }, answer.status)
      }
      const decision = (body as { status: Decision }).status
      for (const status of Object.keys(lists) as ReviewModerationStatus[]) {
        const found = lists[status].find((r) => r.id === id)
        if (found === undefined) continue
        lists[status] = lists[status].filter((r) => r.id !== id)
        lists[decision] = [{ ...found, moderationStatus: decision }, ...lists[decision]]
      }
      return json({ data: { ok: true } })
    }
    return json({ data: {} })
  })
  const posts = () => sent.filter((s) => s.method === 'POST' && s.path.endsWith('/moderate'))
  return {
    sent,
    posts,
    /** The moderate POSTs about one review. */
    postsAbout: (id: string) =>
      posts().filter((s) => s.path === `/api/admin/reviews/${id}/moderate`),
    /** The list GETs, each with the status it asked for. */
    listGets: () =>
      sent
        .filter((s) => s.method === 'GET' && s.path === '/api/admin/reviews')
        .map((s) => s.status),
    release: () => {
      holding = false
      held.splice(0).forEach((open) => open())
    },
  }
}

/** Every unhandled rejection raised while the test runs. */
function unhandledRejections(): { reasons: unknown[]; stop: () => void } {
  const reasons: unknown[] = []
  const record = (reason: unknown) => void reasons.push(reason)
  process.on('unhandledRejection', record)
  return { reasons, stop: () => void process.off('unhandledRejection', record) }
}

const aTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

function renderPage() {
  return renderWithProviders(<ReviewsPage />, { initialPath: '/reviews', dataRouter: true })
}

const rowOf = (id: string) =>
  screen.findByTestId(`admin-reviews-row-${id}`, undefined, { timeout: 5000 })
const approveOf = (id: string) => screen.getByTestId(`admin-reviews-approve-${id}`)
const rejectOf = (id: string) => screen.getByTestId(`admin-reviews-reject-${id}`)
const buttonOf = (id: string, decision: Decision) =>
  decision === 'approved' ? approveOf(id) : rejectOf(id)

const DECISIONS = [
  {
    decision: 'approved' as const,
    done: 'Approved',
    fallback: 'The review could not be approved.',
  },
  {
    decision: 'rejected' as const,
    done: 'Rejected',
    fallback: 'The review could not be rejected.',
  },
]

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('a pending row shows what a moderator decides on', () => {
  // Kills: a row that hides the product, the rating, the title or the body; "Verified purchase" on every row or none;
  // a deleted product linked to /products/null.
  it('AC-4: each row shows its product as a link to /products/<slug> (or "Deleted product" with no link), "<n> of 5", its title and whole body, and "Verified purchase" exactly when an order verified it', async () => {
    fakeApi({ pending: [VERIFIED, ORPHAN] })
    renderPage()

    for (const r of [VERIFIED, ORPHAN]) {
      const row = await rowOf(r.id)
      const text = row.textContent ?? ''
      expect(
        {
          rating: text.includes(`${r.rating} of 5`),
          title: text.includes(r.title),
          body: text.includes(r.body),
          verified: text.includes('Verified purchase'),
          deleted: text.includes('Deleted product'),
          null: text.includes('null'),
        },
        `row ${r.id}: ${text}`,
      ).toEqual({
        rating: true,
        title: true,
        body: true,
        verified: r.orderId !== null,
        deleted: r.productName === null,
        null: false,
      })
      expect(
        within(row)
          .queryAllByRole('link')
          .map((a) => [a.textContent?.trim(), a.getAttribute('href')]),
        `row ${r.id}: its links`,
      ).toEqual(r.productSlug === null ? [] : [[r.productName, `/products/${r.productSlug}`]])
    }
    expect(screen.queryByText('No reviews waiting.')).toBeNull()
  })

  // Kills: an empty queue that renders nothing, or a blank table, so the moderator cannot tell it is done.
  it('AC-4: an empty pending answer shows "No reviews waiting." and no row', async () => {
    const api = fakeApi({})
    renderPage()

    await waitFor(() => expect(api.listGets().length, 'list reads').toBeGreaterThan(0))
    const empty = await screen.findByText('No reviews waiting.', undefined, { timeout: 5000 })
    expect(empty.textContent?.trim()).toBe('No reviews waiting.')
    expect(screen.queryAllByTestId(/^admin-reviews-row-/)).toEqual([])
  })
})

describe('a decision on a row is reported as the server answered it', () => {
  // Kills: a decision posted with the wrong status or to the wrong review; the list not read again after it; an
  // outcome line that names no product, or "null" for a deleted one.
  it.each(DECISIONS)(
    'AC-5: $done on a row sends one POST …/moderate with { status: $decision }; on 200 the list is read again, the row leaves the pending tab and the outcome line reads "$done the review of <name>" ("a deleted product" when the name is null)',
    async ({ decision, done }) => {
      const api = fakeApi({ pending: [VERIFIED, ORPHAN] })
      renderPage()
      await rowOf(VERIFIED.id)
      await rowOf(ORPHAN.id)
      const readsBefore = api.listGets().length

      fireEvent.click(buttonOf(VERIFIED.id, decision))

      const result = await screen.findByTestId('admin-reviews-result', undefined, { timeout: 5000 })
      await waitFor(() =>
        expect(result.textContent?.trim()).toBe(`${done} the review of ${VERIFIED.productName}`),
      )
      expect(result).toHaveAttribute('role', 'status')
      expect(api.posts().map((p) => [p.path, p.body])).toEqual([
        [`/api/admin/reviews/${VERIFIED.id}/moderate`, { status: decision }],
      ])
      await waitFor(() =>
        expect(screen.queryByTestId(`admin-reviews-row-${VERIFIED.id}`)).toBeNull(),
      )
      expect(api.listGets().length, 'list reads after the decision').toBeGreaterThan(readsBefore)
      expect(screen.queryByTestId(`admin-reviews-row-${ORPHAN.id}`)).not.toBeNull()

      fireEvent.click(buttonOf(ORPHAN.id, decision))

      await waitFor(() =>
        expect(screen.getByTestId('admin-reviews-result').textContent?.trim()).toBe(
          `${done} the review of a deleted product`,
        ),
      )
      expect(api.posts().map((p) => p.path)).toEqual([
        `/api/admin/reviews/${VERIFIED.id}/moderate`,
        `/api/admin/reviews/${ORPHAN.id}/moderate`,
      ])
    },
  )

  // Kills: a refusal dropped (`void mutateAsync`), the row removed on a decision the server refused, its buttons left
  // disabled, or the server's reason replaced by a generic one.
  it.each(
    DECISIONS.flatMap((d) => [
      { ...d, status: 404, code: 'not_found', message: 'Review not found' },
      { ...d, status: 500, code: 'internal', message: 'The store could not save that just now' },
    ]),
  )(
    'AC-5: $done answered $status $code shows the ApiError’s message in the alert, keeps the row with both its buttons enabled, reports no outcome and raises no unhandled rejection',
    async ({ decision, status, code, message }) => {
      const rejections = unhandledRejections()
      const api = fakeApi(
        { pending: [VERIFIED] },
        { answers: [{ kind: 'refused', status, code, message }] },
      )
      renderPage()
      await rowOf(VERIFIED.id)

      fireEvent.click(buttonOf(VERIFIED.id, decision))

      const alert = await screen.findByTestId('admin-reviews-error', undefined, { timeout: 5000 })
      await waitFor(() => expect(alert.textContent?.trim()).toBe(message))
      await aTurn()
      await aTurn()
      rejections.stop()

      expect(alert).toHaveAttribute('role', 'alert')
      expect(api.postsAbout(VERIFIED.id).length).toBe(1)
      expect(screen.queryByTestId(`admin-reviews-row-${VERIFIED.id}`)).not.toBeNull()
      expect(approveOf(VERIFIED.id)).toBeEnabled()
      expect(rejectOf(VERIFIED.id)).toBeEnabled()
      expect(screen.queryByTestId('admin-reviews-result')).toBeNull()
      expect(rejections.reasons.map(String), 'unhandled rejections').toEqual([])
    },
  )

  // Kills: a rejection that is not an ApiError (the network) shown as nothing, or as "undefined".
  it.each(DECISIONS)(
    'AC-5: $done that rejects with no ApiError (fetch throws) shows "$fallback", keeps the row enabled and raises no unhandled rejection',
    async ({ decision, fallback }) => {
      const rejections = unhandledRejections()
      fakeApi({ pending: [VERIFIED] }, { answers: [{ kind: 'throws' }] })
      renderPage()
      await rowOf(VERIFIED.id)

      fireEvent.click(buttonOf(VERIFIED.id, decision))

      const alert = await screen.findByTestId('admin-reviews-error', undefined, { timeout: 5000 })
      await waitFor(() => expect(alert.textContent?.trim()).toBe(fallback))
      await aTurn()
      await aTurn()
      rejections.stop()

      expect(alert).toHaveAttribute('role', 'alert')
      expect(screen.queryByTestId(`admin-reviews-row-${VERIFIED.id}`)).not.toBeNull()
      expect(approveOf(VERIFIED.id)).toBeEnabled()
      expect(rejectOf(VERIFIED.id)).toBeEnabled()
      expect(rejections.reasons.map(String), 'unhandled rejections').toEqual([])
    },
  )
})

describe('one click is one decision, row by row', () => {
  // Kills: a click while the POST is open making a second decision; an Approve and a Reject of one review racing;
  // one shared in-flight flag, so a second row's start or end re-enables the first; one hook-level key shared by
  // every row (the server answers a second row 409 idempotency.key_reused).
  it('AC-6: with the first row’s Approve held open, Approve and Reject clicked again on it send nothing and both its buttons are disabled; Approve on a second row sends that row’s one POST under a different key, and the first row’s buttons stay disabled', async () => {
    const second = review({ id: 'rv-second', productName: 'Wool Scarf', productSlug: 'wool-scarf' })
    const api = fakeApi({ pending: [VERIFIED, second] }, { holding: true })
    renderPage()
    await rowOf(VERIFIED.id)
    await rowOf(second.id)

    fireEvent.click(approveOf(VERIFIED.id))
    await waitFor(() => expect(api.postsAbout(VERIFIED.id).length).toBe(1))
    await waitFor(() => expect(approveOf(VERIFIED.id)).toBeDisabled())
    fireEvent.click(approveOf(VERIFIED.id))
    fireEvent.click(rejectOf(VERIFIED.id))
    await aTurn()

    expect(api.postsAbout(VERIFIED.id).length, 'POSTs about the first review').toBe(1)
    expect(rejectOf(VERIFIED.id)).toBeDisabled()
    expect(approveOf(second.id)).toBeEnabled()

    fireEvent.click(approveOf(second.id))
    await waitFor(() => expect(api.postsAbout(second.id).length).toBe(1))
    await waitFor(() => expect(approveOf(second.id)).toBeDisabled())

    expect(approveOf(VERIFIED.id), 'the first row once the second starts').toBeDisabled()
    expect(rejectOf(VERIFIED.id), 'the first row once the second starts').toBeDisabled()
    expect(api.postsAbout(VERIFIED.id).length).toBe(1)
    const [firstKey] = api.postsAbout(VERIFIED.id).map((p) => p.key)
    const [secondKey] = api.postsAbout(second.id).map((p) => p.key)
    expect(KEY_PATTERN.test(firstKey ?? ''), `first key ${firstKey}`).toBe(true)
    expect(KEY_PATTERN.test(secondKey ?? ''), `second key ${secondKey}`).toBe(true)
    expect(secondKey, 'the second row’s key').not.toBe(firstKey)

    await act(async () => {
      api.release()
    })
  })

  // Kills: a fresh key per click, so k clicks landing before the re-render are k decisions the server cannot fold.
  it('AC-6: property: k rapid clicks on a row’s Approve before a re-render all carry that row’s one well-formed Idempotency-Key', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 2, max: 6 }), async (k) => {
        const api = fakeApi({ pending: [VERIFIED] }, { holding: true })
        const { unmount } = renderPage()
        try {
          await rowOf(VERIFIED.id)
          const button = approveOf(VERIFIED.id)

          act(() => {
            for (let i = 0; i < k; i += 1) button.click()
          })
          await waitFor(() => expect(api.postsAbout(VERIFIED.id).length).toBeGreaterThan(0))
          await aTurn()

          const keys = api.postsAbout(VERIFIED.id).map((p) => p.key)
          expect(keys.length, `${k} clicks: POSTs`).toBeLessThanOrEqual(k)
          expect(new Set(keys).size, `${k} clicks: keys ${JSON.stringify(keys)}`).toBe(1)
          expect(KEY_PATTERN.test(keys[0] ?? ''), `key ${keys[0]}`).toBe(true)
        } finally {
          await act(async () => {
            api.release()
          })
          unmount()
          vi.unstubAllGlobals()
        }
      }),
      // Each run renders the page; a failing one is reported as found, not shrunk through more renders.
      { numRuns: 5, endOnFailure: true },
    )
  }, 30_000)
})

describe('a decision is changed from the Approved and Rejected tabs', () => {
  // Kills: tabs that all read the pending queue; an Approved row offering Approve (no undo of a wrong approval); a
  // decision there that leaves the row on its old tab.
  it('AC-7: the Approved tab requests status=approved and offers Reject only; Reject there reads the list again and the row leaves the tab; the Rejected tab requests status=rejected, offers Approve only, and Approve there moves the row out', async () => {
    const approved = review({
      id: 'rv-approved',
      moderationStatus: 'approved',
      productName: 'Canvas Tote',
    })
    const rejected = review({
      id: 'rv-rejected',
      moderationStatus: 'rejected',
      productName: 'Felt Hat',
    })
    const api = fakeApi({ pending: [VERIFIED], approved: [approved], rejected: [rejected] })
    const user = userEvent.setup()
    renderPage()
    await rowOf(VERIFIED.id)

    await user.click(screen.getByTestId('admin-reviews-tab-approved'))
    await rowOf(approved.id)
    expect(api.listGets()).toContain('approved')
    expect(
      screen.queryByTestId(`admin-reviews-row-${VERIFIED.id}`),
      'a pending row on Approved',
    ).toBeNull()
    expect(screen.queryByTestId(`admin-reviews-approve-${approved.id}`)).toBeNull()
    const approvedReads = api.listGets().filter((s) => s === 'approved').length

    await user.click(rejectOf(approved.id))

    await waitFor(() => expect(screen.queryByTestId(`admin-reviews-row-${approved.id}`)).toBeNull())
    expect(api.posts().map((p) => [p.path, p.body])).toEqual([
      [`/api/admin/reviews/${approved.id}/moderate`, { status: 'rejected' }],
    ])
    expect(api.listGets().filter((s) => s === 'approved').length).toBeGreaterThan(approvedReads)
    expect(await screen.findByText('No approved reviews.')).toHaveTextContent(
      /^No approved reviews\.$/,
    )

    await user.click(screen.getByTestId('admin-reviews-tab-rejected'))
    await rowOf(rejected.id)
    await rowOf(approved.id)
    expect(api.listGets()).toContain('rejected')
    expect(screen.queryByTestId(`admin-reviews-reject-${rejected.id}`)).toBeNull()
    expect(screen.queryByTestId(`admin-reviews-reject-${approved.id}`)).toBeNull()

    await user.click(approveOf(rejected.id))
    await user.click(approveOf(approved.id))

    await waitFor(() => expect(screen.queryAllByTestId(/^admin-reviews-row-/)).toEqual([]))
    expect(
      api
        .posts()
        .slice(1)
        .map((p) => [p.path, p.body]),
    ).toEqual([
      [`/api/admin/reviews/${rejected.id}/moderate`, { status: 'approved' }],
      [`/api/admin/reviews/${approved.id}/moderate`, { status: 'approved' }],
    ])
    expect(await screen.findByText('No rejected reviews.')).toHaveTextContent(
      /^No rejected reviews\.$/,
    )
  })
})
