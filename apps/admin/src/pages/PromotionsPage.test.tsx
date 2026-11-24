import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import fc from 'fast-check'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { formatMoney, parseMoney, toMoneyInput } from '@/lib/money'
import { polyfillRadix } from '@/tests/order-page'
import { renderWithProviders } from '@/tests/render'
import type { AdminPromotion } from '@/types'
import { PromotionsPage } from './PromotionsPage'

// The promotions page against a fake admin API (fetch stubbed): `GET /api/admin/me` names the store's currency,
// `GET /api/admin/promotions` answers the promotions it holds, a POST creates one, a PATCH merges its body over the
// stored one (a field left out is kept, a null clears it), and a DELETE removes one no order has used. A write takes the
// next of the test's answers (applied when none is left) and waits while the test holds it.
//
// The browser's zone is Asia/Kolkata (UTC+5:30) for the file, so a time shown or sent in UTC instead of local time
// reads differently from the local one.

const AT = '2026-11-20T10:00:00.000Z'
const ZONE = 'Asia/Kolkata'
const KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/
const IN_USE = 'A promotion an order has used cannot be deleted'

type Answer =
  | { kind: 'applied' }
  | { kind: 'refused'; status: number; code: string; message: string }

interface Sent {
  method: string
  path: string
  query: URLSearchParams
  body: unknown
  key: string | null
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

function promotion(
  over: Partial<AdminPromotion> & Pick<AdminPromotion, 'id' | 'code'>,
): AdminPromotion {
  return {
    kind: 'percent',
    percentBps: 1000,
    amountOffMinor: null,
    currency: null,
    minimumSubtotalMinor: null,
    expiresAt: null,
    usageCap: null,
    active: true,
    createdAt: AT,
    updatedAt: AT,
    usedCount: 0,
    ...over,
  }
}

const isWrite = (s: Sent) => s.method !== 'GET' && s.path.startsWith('/api/admin/promotions')

/**
 * The admin API holding `seed` in a store of `currency`. `hold` names the writes that wait for `release`; `redeemed`
 * the ids an order has used, cancelled or not, which the server refuses to delete. As the server does, a key sent again
 * with another request is answered 409 idempotency.key_reused.
 */
function fakeApi(
  seed: AdminPromotion[],
  opts: {
    currency?: string
    answers?: Answer[]
    hold?: (s: Sent) => boolean
    redeemed?: string[]
  } = {},
) {
  let list = [...seed]
  const sent: Sent[] = []
  const held: Array<() => void> = []
  let holding = true
  let listsHeld = false
  const heldLists: Array<() => void> = []
  let writes = 0
  let created = 0
  const requestOfKey = new Map<string, string>()
  vi.stubGlobal('fetch', async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(
      String(input instanceof Request ? input.url : input),
      'http://localhost/admin/',
    )
    const method = (init.method ?? 'GET').toUpperCase()
    const body: unknown = typeof init.body === 'string' ? JSON.parse(init.body) : undefined
    const s: Sent = {
      method,
      path: url.pathname,
      query: url.searchParams,
      body,
      key: new Headers(init.headers).get('idempotency-key'),
    }
    sent.push(s)
    if (url.pathname === '/api/csrf') return json({ data: { token: 'csrf-tok' } })
    if (url.pathname === '/api/admin/me') {
      return json({
        data: {
          userId: 'u-admin',
          roles: ['admin'],
          storeName: 'Test Store',
          environment: 'development',
          currency: opts.currency ?? 'GBP',
        },
      })
    }
    if (method === 'GET' && url.pathname === '/api/admin/promotions') {
      if (listsHeld) await new Promise<void>((resolve) => heldLists.push(resolve))
      return json({ data: list })
    }
    if (!isWrite(s)) return json({ data: {} })

    const request = JSON.stringify([method, url.pathname, body])
    if (s.key !== null && (requestOfKey.get(s.key) ?? request) !== request) {
      return json(
        {
          error: {
            code: 'idempotency.key_reused',
            message: 'This Idempotency-Key was used with a different request',
          },
        },
        409,
      )
    }
    if (s.key !== null) requestOfKey.set(s.key, request)
    const answer = opts.answers?.[writes] ?? { kind: 'applied' }
    writes += 1
    if (holding && opts.hold?.(s)) await new Promise<void>((resolve) => held.push(resolve))
    if (answer.kind === 'refused') {
      return json({ error: { code: answer.code, message: answer.message } }, answer.status)
    }
    const one = /^\/api\/admin\/promotions\/([^/]+)$/.exec(url.pathname)
    if (method === 'POST' && url.pathname === '/api/admin/promotions') {
      created += 1
      const fields = body as Partial<AdminPromotion>
      const made = promotion({
        id: `promo-new-${created}`,
        code: String(fields.code),
        ...fields,
        active: fields.active ?? true,
        usedCount: 0,
      })
      list = [made, ...list]
      return json({ data: made }, 201)
    }
    if (method === 'PATCH' && one) {
      const id = decodeURIComponent(one[1]!)
      const stored = list.find((p) => p.id === id)
      if (stored === undefined) {
        return json({ error: { code: 'promotion.not_found', message: `No promotion ${id}` } }, 404)
      }
      const kept = Object.fromEntries(
        Object.entries(body as Record<string, unknown>).filter(([, v]) => v !== undefined),
      )
      const updated = { ...stored, ...kept, updatedAt: AT }
      list = list.map((p) => (p.id === id ? updated : p))
      return json({ data: updated })
    }
    if (method === 'DELETE' && one) {
      const id = decodeURIComponent(one[1]!)
      if (opts.redeemed?.includes(id)) {
        return json({ error: { code: 'promotion.in_use', message: IN_USE } }, 409)
      }
      list = list.filter((p) => p.id !== id)
      return json({ data: { ok: true } })
    }
    return json({ data: {} })
  })
  return {
    sent,
    /** The writes to the promotions routes, in the order sent. */
    writes: () => sent.filter(isWrite),
    /** The writes of one method, as [path, body]. */
    of: (method: string) => sent.filter((s) => isWrite(s) && s.method === method),
    listGets: () => sent.filter((s) => s.method === 'GET' && s.path === '/api/admin/promotions'),
    release: () => {
      holding = false
      held.splice(0).forEach((open) => open())
    },
    /** From now on each read of the list waits for `releaseLists`. */
    holdLists: () => {
      listsHeld = true
    },
    releaseLists: () => {
      listsHeld = false
      heldLists.splice(0).forEach((open) => open())
    },
  }
}

const aTurn = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
const two = (n: number) => String(n).padStart(2, '0')
/** An instant as a `datetime-local` value in the browser's zone. */
const localInput = (iso: string): string => {
  const d = new Date(iso)
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}`
}
/** An instant's hours and minutes in the browser's zone, and in UTC. */
const localClock = (iso: string) => {
  const d = new Date(iso)
  return `${two(d.getHours())}:${two(d.getMinutes())}`
}
const utcClock = (iso: string) => iso.slice(11, 16)
/** A sentence, with or without a closing full stop. */
const sentence = (text: string) =>
  new RegExp(`^${text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.?$`)

function renderPage() {
  return renderWithProviders(<PromotionsPage />, { initialPath: '/promotions', dataRouter: true })
}

const rowOf = (id: string) =>
  screen.findByTestId(`admin-promotions-row-${id}`, undefined, { timeout: 5000 })
const stateOf = (id: string) => screen.getByTestId(`admin-promotions-state-${id}`)
const toggleOf = (id: string) => screen.getByTestId(`admin-promotions-toggle-${id}`)
const editOf = (id: string) => screen.getByTestId(`admin-promotions-edit-${id}`)
const deleteOf = (id: string) => screen.getByTestId(`admin-promotions-delete-${id}`)
const field = (name: string) => screen.getByTestId(`admin-promotion-${name}`) as HTMLInputElement
const text = (el: Element | null) => el?.textContent?.trim() ?? ''

/** The texts of a table row's cells. */
const cellsOf = (row: HTMLElement): string[] =>
  [...within(row).queryAllByRole('rowheader'), ...within(row).queryAllByRole('cell')].map(text)

/** Opens the New dialog once the session's currency and the list are in. */
async function openNew(user: ReturnType<typeof userEvent.setup>, api: ReturnType<typeof fakeApi>) {
  await waitFor(() =>
    expect(
      api.sent.some((s) => s.path === '/api/admin/me'),
      'the session read',
    ).toBe(true),
  )
  const button = await screen.findByTestId('admin-promotions-new', undefined, { timeout: 5000 })
  await waitFor(() => expect(button).toBeEnabled())
  await user.click(button)
  return screen.findByTestId('admin-promotion-dialog')
}

/** Picks a kind on the kind control: a native select, or a group whose options are labelled by their text. */
async function chooseKind(
  user: ReturnType<typeof userEvent.setup>,
  label: 'Percent' | 'Fixed amount',
) {
  const kind = screen.getByTestId('admin-promotion-kind')
  if (kind instanceof HTMLSelectElement) {
    const option = [...kind.options].find((o) => text(o) === label)
    expect(option, `the kind select offers ${label}`).toBeInstanceOf(HTMLOptionElement)
    await user.selectOptions(kind, option!)
  } else {
    await user.click(within(kind).getByText(label, { exact: true }))
  }
}

async function typeInto(user: ReturnType<typeof userEvent.setup>, name: string, value: string) {
  const input = field(name)
  await user.clear(input)
  if (value !== '') await user.type(input, value)
}

/** A `datetime-local` value, as the browser's picker sets it. */
const setExpires = (value: string) => fireEvent.change(field('expires'), { target: { value } })

interface Form {
  code: string
  kind: 'Percent' | 'Fixed amount'
  value: string
  minimum?: string
  expires?: string
  cap?: string
}

async function fillForm(user: ReturnType<typeof userEvent.setup>, form: Form) {
  await typeInto(user, 'code', form.code)
  await chooseKind(user, form.kind)
  await typeInto(user, 'value', form.value)
  if (form.minimum !== undefined) await typeInto(user, 'minimum', form.minimum)
  if (form.expires !== undefined) setExpires(form.expires)
  if (form.cap !== undefined) await typeInto(user, 'cap', form.cap)
}

const original = process.env.TZ

beforeAll(() => {
  polyfillRadix()
  process.env.TZ = ZONE
})

afterAll(() => {
  if (original === undefined) delete process.env.TZ
  else process.env.TZ = original
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// A percent code; a fixed code with a minimum, an expiry and a cap; and one of each other state.
const TEN = promotion({ id: 'promo-ten', code: 'TENOFF', percentBps: 1000 })
const HALF = promotion({ id: 'promo-half', code: 'TWELVEHALF', percentBps: 1250, usedCount: 4 })
const FIVE = promotion({
  id: 'promo-five',
  code: 'FIVEPOUNDS',
  kind: 'fixed',
  percentBps: null,
  amountOffMinor: 500,
  currency: 'GBP',
  minimumSubtotalMinor: 3000,
  expiresAt: '2099-06-15T18:45:00.000Z',
  usageCap: 10,
  usedCount: 3,
})
const OFF = promotion({
  id: 'promo-off',
  code: 'SWITCHEDOFF',
  active: false,
  expiresAt: '2026-01-01T00:00:00.000Z',
})
const GONE = promotion({
  id: 'promo-gone',
  code: 'LASTYEAR',
  expiresAt: '2026-01-01T00:00:00.000Z',
})
const FULL = promotion({ id: 'promo-full', code: 'ALLUSED', usageCap: 5, usedCount: 5 })

describe('a row shows what the code gives, how often it was used and whether it works', () => {
  // Kills: amounts shown in minor units ("500"), basis points shown as the percent ("1000%"), the expiry in UTC, the
  // cap left out of the uses, or a state that does not follow the engine's order.
  it('AC-3: rows show "10%" / "12.5%" / "£5.00 off", "None" / "£30.00", "Never" / the expiry in local time, "0" / "3 of 10", and Active, Inactive, Expired or Used up', async () => {
    fakeApi([TEN, HALF, FIVE, OFF, GONE, FULL])
    renderPage()

    const ten = cellsOf(await rowOf(TEN.id))
    const five = cellsOf(await rowOf(FIVE.id))
    const half = cellsOf(await rowOf(HALF.id))
    await waitFor(() =>
      expect(cellsOf(screen.getByTestId(`admin-promotions-row-${FIVE.id}`))).toContain(
        `${formatMoney(500, 'GBP')} off`,
      ),
    )

    expect(ten, 'the percent row').toEqual(
      expect.arrayContaining(['TENOFF', '10%', 'None', 'Never', '0']),
    )
    expect(half, 'a percent with a fraction').toEqual(expect.arrayContaining(['12.5%', '4']))
    expect(five, 'the fixed row').toEqual(
      expect.arrayContaining([
        'FIVEPOUNDS',
        `${formatMoney(500, 'GBP')} off`,
        formatMoney(3000, 'GBP'),
        '3 of 10',
      ]),
    )
    const expiry = five.filter((c) => c.includes(localClock(FIVE.expiresAt!)))
    expect(
      expiry,
      `the fixed row's expiry at ${localClock(FIVE.expiresAt!)} local: ${JSON.stringify(five)}`,
    ).toHaveLength(1)
    expect(expiry[0], 'the expiry in local time, not UTC').not.toContain(utcClock(FIVE.expiresAt!))
    expect(expiry[0], 'the local year').toContain(String(new Date(FIVE.expiresAt!).getFullYear()))
    expect(
      five.some((c) => c === '500' || c === '3000'),
      'minor units shown',
    ).toBe(false)

    expect([TEN, FIVE, OFF, GONE, FULL].map((p) => text(stateOf(p.id)))).toEqual([
      'Active',
      'Active',
      'Inactive',
      'Expired',
      'Used up',
    ])
    expect(screen.queryByText('No promotions yet.')).toBeNull()
  })

  // Kills: an empty store that renders a blank table.
  it('AC-3: an empty answer shows "No promotions yet." and no row', async () => {
    const api = fakeApi([])
    renderPage()

    await waitFor(() => expect(api.listGets().length, 'list reads').toBeGreaterThan(0))
    const empty = await screen.findByText('No promotions yet.', undefined, { timeout: 5000 })
    expect(text(empty)).toBe('No promotions yet.')
    expect(screen.queryAllByTestId(/^admin-promotions-row-/)).toEqual([])
  })
})

describe('a new code is sent as typed', () => {
  // Kills: a percent sent as 12.5 or by a float multiply; a field left out instead of null; active not defaulted.
  it('AC-4: a percent code "12.5" with nothing else sends one POST with percentBps 1250 and every other field null, active true; the result reads "Created <code>"', async () => {
    const api = fakeApi([TEN])
    const user = userEvent.setup()
    renderPage()
    await rowOf(TEN.id)
    await openNew(user, api)

    await fillForm(user, { code: 'SPRING-12', kind: 'Percent', value: '12.5' })
    await user.click(field('save'))

    const result = await screen.findByTestId('admin-promotions-result', undefined, {
      timeout: 5000,
    })
    await waitFor(() => expect(text(result)).toBe('Created SPRING-12'))
    expect(result).toHaveAttribute('role', 'status')
    expect(api.writes().map((w) => [w.method, w.path, w.body])).toEqual([
      [
        'POST',
        '/api/admin/promotions',
        {
          code: 'SPRING-12',
          kind: 'percent',
          percentBps: 1250,
          amountOffMinor: null,
          currency: null,
          minimumSubtotalMinor: null,
          expiresAt: null,
          usageCap: null,
          active: true,
        },
      ],
    ])
  })

  // Kills: a minimum sent with no currency (the server refuses it); an expiry read as UTC; a cap sent as text.
  it('AC-4: a fixed code with a minimum, an expiry and a cap in GBP sends the amounts parseMoney reads, currency GBP, the typed local time as its ISO instant and the cap as a number', async () => {
    const api = fakeApi([TEN])
    const user = userEvent.setup()
    renderPage()
    await rowOf(TEN.id)
    await openNew(user, api)
    const typed = '2026-12-31T23:30'

    await fillForm(user, {
      code: 'WINTER5',
      kind: 'Fixed amount',
      value: '5',
      minimum: '30',
      expires: typed,
      cap: '10',
    })
    await user.click(field('save'))

    await waitFor(() => expect(api.of('POST')).toHaveLength(1))
    const instant = new Date(typed).toISOString()
    expect(instant, 'the local time differs from the same digits in UTC').not.toBe(
      `${typed}:00.000Z`,
    )
    expect(api.of('POST')[0]!.body).toEqual({
      code: 'WINTER5',
      kind: 'fixed',
      percentBps: null,
      amountOffMinor: parseMoney('5', 'GBP'),
      currency: 'GBP',
      minimumSubtotalMinor: parseMoney('30', 'GBP'),
      expiresAt: instant,
      usageCap: 10,
      active: true,
    })
    await waitFor(() =>
      expect(text(screen.getByTestId('admin-promotions-result'))).toBe('Created WINTER5'),
    )
  })

  // Kills: the currency sent only for a fixed code, so a percent code with a minimum is refused.
  it('AC-4: a percent code with a minimum also sends currency GBP and the minimum in minor units', async () => {
    const api = fakeApi([TEN])
    const user = userEvent.setup()
    renderPage()
    await rowOf(TEN.id)
    await openNew(user, api)

    await fillForm(user, { code: 'OVER20', kind: 'Percent', value: '15', minimum: '20' })
    await user.click(field('save'))

    await waitFor(() => expect(api.of('POST')).toHaveLength(1))
    expect(api.of('POST')[0]!.body).toMatchObject({
      kind: 'percent',
      percentBps: 1500,
      amountOffMinor: null,
      currency: 'GBP',
      minimumSubtotalMinor: parseMoney('20', 'GBP'),
    })
  })

  // Kills: an amount multiplied by 100 whatever the currency: 500 JPY sent as 50000.
  it('AC-4: in JPY, "500" sends amountOffMinor 500 and currency JPY', async () => {
    const api = fakeApi([TEN], { currency: 'JPY' })
    const user = userEvent.setup()
    renderPage()
    await rowOf(TEN.id)
    await openNew(user, api)

    await fillForm(user, { code: 'YEN500', kind: 'Fixed amount', value: '500' })
    await user.click(field('save'))

    await waitFor(() => expect(api.of('POST')).toHaveLength(1))
    expect(api.of('POST')[0]!.body).toMatchObject({
      kind: 'fixed',
      amountOffMinor: 500,
      currency: 'JPY',
    })
  })

  // Kills: a fixed exponent of 2 (KWD's 3 digits or JPY's none read wrong), or a float multiply between field and body.
  it('AC-4: property: in GBP, JPY and KWD, a fixed amount typed as toMoneyInput gives of n minor units is sent as amountOffMinor n in the store currency', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('GBP', 'JPY', 'KWD'),
        fc.integer({ min: 1, max: 5_000_000 }),
        async (currency, minor) => {
          const api = fakeApi([TEN], { currency })
          const user = userEvent.setup()
          const { unmount } = renderPage()
          try {
            await rowOf(TEN.id)
            await openNew(user, api)
            const typed = toMoneyInput(minor, currency)
            await fillForm(user, { code: 'ANYAMOUNT', kind: 'Fixed amount', value: typed })
            await user.click(field('save'))

            await waitFor(() => expect(api.of('POST')).toHaveLength(1))
            const body = api.of('POST')[0]!.body as { amountOffMinor: number; currency: string }
            expect(
              { amountOffMinor: body.amountOffMinor, currency: body.currency },
              `"${typed}" ${currency}`,
            ).toEqual({
              amountOffMinor: minor,
              currency,
            })
          } finally {
            unmount()
            vi.unstubAllGlobals()
          }
        },
      ),
      // Each run renders the page; a failing one is reported as found, not shrunk through more renders.
      { numRuns: 6, endOnFailure: true },
    )
  }, 30_000)
})

const UNREADABLE: Array<{ what: string; form: Form; says: string }> = [
  {
    what: '"abc" as a percent',
    form: { code: 'BAD1', kind: 'Percent', value: 'abc' },
    says: 'Enter a percent between 0.01 and 99.99',
  },
  {
    what: '"0" as a percent',
    form: { code: 'BAD2', kind: 'Percent', value: '0' },
    says: 'Enter a percent between 0.01 and 99.99',
  },
  {
    what: '"100" as a percent',
    form: { code: 'BAD3', kind: 'Percent', value: '100' },
    says: 'Enter a percent between 0.01 and 99.99',
  },
  {
    what: '"1.999" as a GBP amount',
    form: { code: 'BAD4', kind: 'Fixed amount', value: '1.999' },
    says: 'Enter an amount in GBP',
  },
  {
    what: '"0" as a cap',
    form: { code: 'BAD5', kind: 'Percent', value: '10', cap: '0' },
    says: 'Enter a whole number of uses, 1 or more',
  },
  {
    what: '"2.5" as a cap',
    form: { code: 'BAD6', kind: 'Percent', value: '10', cap: '2.5' },
    says: 'Enter a whole number of uses, 1 or more',
  },
]

describe('a value the page or the server refuses is said in the dialog', () => {
  // Kills: an unreadable value sent anyway (the server's sentence about basis points), or the dialog closed on it.
  it.each(UNREADABLE)(
    'AC-5: $what shows "$says" in the dialog’s alert and sends nothing',
    async ({ form, says }) => {
      const api = fakeApi([TEN])
      const user = userEvent.setup()
      renderPage()
      await rowOf(TEN.id)
      await openNew(user, api)

      await fillForm(user, form)
      await user.click(field('save'))

      const alert = await screen.findByTestId('admin-promotion-error', undefined, { timeout: 5000 })
      await waitFor(() => expect(text(alert)).toMatch(sentence(says)))
      await aTurn()
      expect(alert).toHaveAttribute('role', 'alert')
      expect(api.writes(), 'writes sent').toEqual([])
      expect(screen.queryByTestId('admin-promotion-dialog'), 'the dialog').not.toBeNull()
    },
  )

  // Kills: a refusal that closes the dialog, loses what was typed, leaves Save disabled, or reports a code made.
  it.each([
    { status: 400, code: 'promotion.invalid', message: 'a minimum needs a currency' },
    { status: 409, code: 'promotion.code_taken', message: 'The code SUMMER10 is taken' },
  ])(
    'AC-5: a $status $code answer shows the server’s message in the dialog’s alert; the dialog stays open with what was typed and Save is enabled again',
    async ({ status, code, message }) => {
      const api = fakeApi([TEN], { answers: [{ kind: 'refused', status, code, message }] })
      const user = userEvent.setup()
      renderPage()
      await rowOf(TEN.id)
      await openNew(user, api)

      await fillForm(user, { code: 'SUMMER10', kind: 'Percent', value: '10', cap: '3' })
      await user.click(field('save'))

      const alert = await screen.findByTestId('admin-promotion-error', undefined, { timeout: 5000 })
      await waitFor(() => expect(text(alert)).toBe(message))
      await waitFor(() => expect(field('save')).toBeEnabled())
      expect(alert).toHaveAttribute('role', 'alert')
      expect(api.of('POST')).toHaveLength(1)
      expect(screen.queryByTestId('admin-promotion-dialog'), 'the dialog').not.toBeNull()
      expect([field('code').value, field('value').value, field('cap').value]).toEqual([
        'SUMMER10',
        '10',
        '3',
      ])
      expect(text(screen.queryByTestId('admin-promotions-result')), 'an outcome line').not.toMatch(
        /^Created/,
      )
    },
  )

  // Kills: a dialog that Escape closes while its POST is open, so the server's refusal lands in no dialog, the page says
  // nothing and the merchant believes the code exists.
  it('AC-5: Escape while the POST is open keeps the dialog and its Cancel is disabled; the 409 promotion.code_taken that follows shows in the dialog’s alert with what was typed, and nothing reads "Created"', async () => {
    const message = 'The code SUMMER10 is taken'
    const api = fakeApi([TEN], {
      hold: (s) => s.method === 'POST',
      answers: [{ kind: 'refused', status: 409, code: 'promotion.code_taken', message }],
    })
    const user = userEvent.setup()
    renderPage()
    await rowOf(TEN.id)
    await openNew(user, api)
    await fillForm(user, { code: 'SUMMER10', kind: 'Percent', value: '10' })

    await user.click(field('save'))
    await waitFor(() => expect(api.of('POST')).toHaveLength(1))
    await user.keyboard('{Escape}')
    await aTurn()

    const dialog = screen.queryByTestId('admin-promotion-dialog')
    expect(dialog, 'the dialog after Escape').not.toBeNull()
    expect(within(dialog!).getByRole('button', { name: 'Cancel' })).toBeDisabled()
    await act(async () => {
      api.release()
    })
    const alert = await screen.findByTestId('admin-promotion-error', undefined, { timeout: 5000 })
    await waitFor(() => expect(text(alert)).toBe(message))
    expect(field('code').value).toBe('SUMMER10')
    expect(api.of('POST')).toHaveLength(1)
    expect(text(screen.queryByTestId('admin-promotions-result')), 'an outcome line').not.toMatch(
      /^Created/,
    )
  })

  // Kills: a Cancel live while the POST is open, so that save's answer closes a dialog opened after it and loses what
  // was typed there.
  it('AC-5: Cancel and the close button while the POST is open keep the dialog with what was typed; once answered it closes and the result reads "Created <code>"', async () => {
    const api = fakeApi([TEN], { hold: (s) => s.method === 'POST' })
    const user = userEvent.setup()
    renderPage()
    await rowOf(TEN.id)
    const dialog = await openNew(user, api)
    await fillForm(user, { code: 'ONCE10', kind: 'Percent', value: '10' })

    await user.click(field('save'))
    await waitFor(() => expect(api.of('POST')).toHaveLength(1))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }))
    await aTurn()

    expect(screen.queryByTestId('admin-promotion-dialog'), 'the dialog after Cancel').not.toBeNull()
    expect(field('code').value).toBe('ONCE10')
    await act(async () => {
      api.release()
    })
    await waitFor(() =>
      expect(text(screen.getByTestId('admin-promotions-result'))).toBe('Created ONCE10'),
    )
    expect(screen.queryByTestId('admin-promotion-dialog'), 'the dialog once answered').toBeNull()
    expect(api.of('POST')).toHaveLength(1)
  })
})

describe('one click is one command', () => {
  // Kills: a second Save or an Enter while the POST is open making a second POST, which the server answers "The code X
  // is taken" over a create that worked.
  it('AC-6: Save clicked, the POST held open, Save clicked again and Enter pressed in the code field send one POST in all; once answered the result reads "Created <code>" and no error shows', async () => {
    const api = fakeApi([TEN], { hold: (s) => s.method === 'POST' })
    const user = userEvent.setup()
    renderPage()
    await rowOf(TEN.id)
    await openNew(user, api)
    await fillForm(user, { code: 'ONCE10', kind: 'Percent', value: '10' })

    await user.click(field('save'))
    await waitFor(() => expect(api.of('POST')).toHaveLength(1))
    fireEvent.click(field('save'))
    field('code').focus()
    await user.keyboard('{Enter}')
    await aTurn()

    expect(api.of('POST'), 'POSTs while the first is open').toHaveLength(1)
    await act(async () => {
      api.release()
    })
    await waitFor(() =>
      expect(text(screen.getByTestId('admin-promotions-result'))).toBe('Created ONCE10'),
    )
    expect(api.of('POST'), 'POSTs in all').toHaveLength(1)
    expect(text(screen.queryByTestId('admin-promotion-error')), 'the dialog’s alert').toBe('')
    expect(text(screen.queryByTestId('admin-promotions-error')), 'the page’s alert').toBe('')
  })

  // Kills: one hook-level key shared by every row (the server answers row B 409 idempotency.key_reused), a shared
  // in-flight flag that disables or re-enables every row together, or a second PATCH from a click while one is open.
  it('AC-6: with row A’s Switch off held open, A sends one PATCH { active: false } and its buttons are disabled; row B’s Switch off stays live, sends its own PATCH under a different key, and B then reads Inactive', async () => {
    const A = promotion({ id: 'promo-a', code: 'ROWA' })
    const B = promotion({ id: 'promo-b', code: 'ROWB' })
    const api = fakeApi([A, B], {
      hold: (s) => s.method === 'PATCH' && s.path.endsWith(`/${A.id}`),
    })
    renderPage()
    await rowOf(A.id)
    await rowOf(B.id)
    expect(text(toggleOf(A.id))).toBe('Switch off')

    fireEvent.click(toggleOf(A.id))
    await waitFor(() => expect(api.of('PATCH')).toHaveLength(1))
    await waitFor(() => expect(toggleOf(A.id)).toBeDisabled())
    fireEvent.click(toggleOf(A.id))
    await aTurn()

    expect(
      [editOf(A.id), deleteOf(A.id)].map((b) => (b as HTMLButtonElement).disabled),
      'row A’s Edit and Delete',
    ).toEqual([true, true])
    expect(toggleOf(B.id)).toBeEnabled()
    fireEvent.click(toggleOf(B.id))
    await waitFor(() => expect(text(stateOf(B.id))).toBe('Inactive'))

    const patches = api.of('PATCH').map((p) => [p.path, p.body])
    expect(patches).toEqual([
      [`/api/admin/promotions/${A.id}`, { active: false }],
      [`/api/admin/promotions/${B.id}`, { active: false }],
    ])
    const [keyA, keyB] = api.of('PATCH').map((p) => p.key)
    expect(KEY_PATTERN.test(keyA ?? ''), `row A's key ${keyA}`).toBe(true)
    expect(KEY_PATTERN.test(keyB ?? ''), `row B's key ${keyB}`).toBe(true)
    expect(keyB, 'row B’s key').not.toBe(keyA)
    expect(toggleOf(A.id), 'row A while its PATCH is open').toBeDisabled()
    expect(text(stateOf(A.id))).toBe('Active')
    await waitFor(() =>
      expect(text(screen.getByTestId('admin-promotions-result'))).toBe('Switched off ROWB'),
    )

    await act(async () => {
      api.release()
    })
    await waitFor(() => expect(text(stateOf(A.id))).toBe('Inactive'))
    expect(api.of('PATCH'), 'PATCHes in all').toHaveLength(2)
  })

  // Kills: a row's key kept after its command settles, so Switch on after Switch off reuses it and the server answers
  // 409 idempotency.key_reused.
  it('AC-6: once Switch off has settled, Switch on of the same row is its own command: its PATCH { active: true } carries a new key and the row reads Active again', async () => {
    const A = promotion({ id: 'promo-a', code: 'ROWA' })
    const api = fakeApi([A])
    renderPage()
    await rowOf(A.id)

    fireEvent.click(toggleOf(A.id))
    await waitFor(() => expect(text(stateOf(A.id))).toBe('Inactive'))
    await waitFor(() => expect(toggleOf(A.id)).toBeEnabled())
    expect(text(toggleOf(A.id))).toBe('Switch on')
    fireEvent.click(toggleOf(A.id))

    await waitFor(() =>
      expect(text(screen.getByTestId('admin-promotions-result'))).toBe('Switched on ROWA'),
    )
    await waitFor(() => expect(text(stateOf(A.id))).toBe('Active'))
    expect(api.of('PATCH').map((p) => p.body)).toEqual([{ active: false }, { active: true }])
    const [off, on] = api.of('PATCH').map((p) => p.key)
    expect(on, 'the second command’s key').not.toBe(off)
    expect(text(screen.queryByTestId('admin-promotions-error')), 'the page’s alert').toBe('')
  })

  // Kills: a row released when its PATCH answers while the list is still being read, so it reads Active with Switch off
  // and Edit live, and an Edit opened from it sends active: true back.
  it('AC-6: Switch off with the list read held open: the row’s buttons stay disabled and no outcome shows until the list lands; then the row reads Inactive with Switch on, and the result "Switched off <code>"', async () => {
    const A = promotion({ id: 'promo-a', code: 'ROWA' })
    const api = fakeApi([A])
    renderPage()
    await rowOf(A.id)
    api.holdLists()
    const reads = api.listGets().length

    fireEvent.click(toggleOf(A.id))
    await waitFor(() => expect(api.listGets().length).toBeGreaterThan(reads))
    await aTurn()

    expect(api.of('PATCH').map((p) => p.body)).toEqual([{ active: false }])
    expect(
      [toggleOf, editOf, deleteOf].map((of) => (of(A.id) as HTMLButtonElement).disabled),
      'row A’s buttons while the list is read',
    ).toEqual([true, true, true])
    expect(text(screen.queryByTestId('admin-promotions-result')), 'the outcome line').toBe('')

    await act(async () => {
      api.releaseLists()
    })
    await waitFor(() =>
      expect(text(screen.getByTestId('admin-promotions-result'))).toBe('Switched off ROWA'),
    )
    expect(text(stateOf(A.id))).toBe('Inactive')
    expect(text(toggleOf(A.id))).toBe('Switch on')
    expect(editOf(A.id)).toBeEnabled()
  })

  // Kills: a confirm that sends a DELETE per click.
  it('AC-6: a double-clicked delete confirm sends one DELETE', async () => {
    const A = promotion({ id: 'promo-a', code: 'ROWA' })
    const api = fakeApi([A], { hold: (s) => s.method === 'DELETE' })
    const user = userEvent.setup()
    renderPage()
    await rowOf(A.id)

    await user.click(deleteOf(A.id))
    const confirm = await screen.findByTestId('admin-promotion-delete-confirm')
    act(() => {
      confirm.click()
      confirm.click()
    })
    await waitFor(() => expect(api.of('DELETE')).toHaveLength(1))
    const still = screen.queryByTestId('admin-promotion-delete-confirm')
    if (still !== null) fireEvent.click(still)
    await aTurn()

    expect(api.of('DELETE'), 'DELETEs while the first is open').toHaveLength(1)
    await act(async () => {
      api.release()
    })
    await waitFor(() => expect(screen.queryByTestId(`admin-promotions-row-${A.id}`)).toBeNull())
    expect(api.of('DELETE').map((d) => d.path)).toEqual([`/api/admin/promotions/${A.id}`])
  })

  // Kills: a fresh key per click, so k clicks landing before the re-render are k commands the server cannot fold.
  it('AC-6: property: k clicks of Save or of a row’s Switch off before a re-render all carry one well-formed Idempotency-Key', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('save' as const, 'switch-off' as const),
        fc.integer({ min: 2, max: 6 }),
        async (action, k) => {
          const api = fakeApi([TEN], { hold: (s) => s.method === 'POST' || s.method === 'PATCH' })
          const user = userEvent.setup()
          const { unmount } = renderPage()
          try {
            await rowOf(TEN.id)
            let button: HTMLElement
            if (action === 'save') {
              await openNew(user, api)
              await fillForm(user, { code: 'KCLICKS', kind: 'Percent', value: '10' })
              button = field('save')
            } else {
              button = toggleOf(TEN.id)
            }

            act(() => {
              for (let i = 0; i < k; i += 1) button.click()
            })
            await waitFor(() => expect(api.writes().length).toBeGreaterThan(0))
            await aTurn()

            const keys = api.writes().map((w) => w.key)
            expect(keys.length, `${action} ×${k}: writes`).toBeLessThanOrEqual(k)
            expect(new Set(keys).size, `${action} ×${k}: keys ${JSON.stringify(keys)}`).toBe(1)
            expect(KEY_PATTERN.test(keys[0] ?? ''), `key ${keys[0]}`).toBe(true)
          } finally {
            await act(async () => {
              api.release()
            })
            unmount()
            vi.unstubAllGlobals()
          }
        },
      ),
      // Each run renders the page; a failing one is reported as found, not shrunk through more renders.
      { numRuns: 6, endOnFailure: true },
    )
  }, 40_000)
})

// A percent code and a fixed code, each with a minimum, an expiry and a cap.
const EDIT_CASES = [
  {
    kind: 'percent',
    p: promotion({
      id: 'promo-edit-p',
      code: 'EDITPCT',
      percentBps: 1250,
      currency: 'GBP',
      minimumSubtotalMinor: 2000,
      expiresAt: '2099-03-10T20:10:00.000Z',
      usageCap: 5,
      usedCount: 2,
    }),
    value: '12.5',
    sent: { kind: 'percent', percentBps: 1250, amountOffMinor: null, currency: null },
  },
  {
    kind: 'fixed',
    p: promotion({
      id: 'promo-edit-f',
      code: 'EDITFIX',
      kind: 'fixed',
      percentBps: null,
      amountOffMinor: 750,
      currency: 'GBP',
      minimumSubtotalMinor: 2000,
      expiresAt: '2099-03-10T20:10:00.000Z',
      usageCap: 5,
      usedCount: 2,
    }),
    value: toMoneyInput(750, 'GBP'),
    sent: { kind: 'fixed', percentBps: null, amountOffMinor: 750, currency: 'GBP' },
  },
]

describe('an edit is a full replace of what the form holds', () => {
  // Kills: a form that opens on other values (basis points as the percent, minor units, a UTC expiry); a cleared field
  // left out of the PATCH, so the server keeps the old value and the form lies.
  it.each(EDIT_CASES)(
    'AC-7: Edit of a $kind code opens with its values; clearing the minimum, expiry and cap sends one PATCH holding every field with those null, and the row then shows "None", "Never" and the bare count',
    async ({ p, value, sent }) => {
      const api = fakeApi([p])
      const user = userEvent.setup()
      renderPage()
      await rowOf(p.id)

      await user.click(editOf(p.id))
      await screen.findByTestId('admin-promotion-dialog')
      expect(
        ['code', 'value', 'minimum', 'expires', 'cap'].map((name) => field(name).value),
        'the form as it opens',
      ).toEqual([
        p.code,
        value,
        toMoneyInput(p.minimumSubtotalMinor!, 'GBP'),
        localInput(p.expiresAt!),
        String(p.usageCap),
      ])

      await typeInto(user, 'minimum', '')
      setExpires('')
      await typeInto(user, 'cap', '')
      await user.click(field('save'))

      await waitFor(() =>
        expect(text(screen.getByTestId('admin-promotions-result'))).toBe(`Saved ${p.code}`),
      )
      expect(api.writes().map((w) => [w.method, w.path, w.body])).toEqual([
        [
          'PATCH',
          `/api/admin/promotions/${p.id}`,
          {
            code: p.code,
            ...sent,
            minimumSubtotalMinor: null,
            expiresAt: null,
            usageCap: null,
            active: true,
          },
        ],
      ])
      await waitFor(() =>
        expect(cellsOf(screen.getByTestId(`admin-promotions-row-${p.id}`))).toEqual(
          expect.arrayContaining(['None', 'Never', String(p.usedCount)]),
        ),
      )
      expect(
        cellsOf(screen.getByTestId(`admin-promotions-row-${p.id}`)).some((c) => c.includes(' of ')),
        'uses still shown against a cap',
      ).toBe(false)
    },
  )
})

describe('a delete is reported as the server answered it', () => {
  // Kills: the page reporting a delete the server refused, or dropping the row before the server answers.
  it('AC-8: Delete of a code an order has used asks "Delete <code>?"; confirmed, the server’s 409 promotion.in_use sentence shows in the page’s alert and the row stays', async () => {
    // Its one use was a cancelled order: not counted in usedCount, still refused by the server.
    const USED = promotion({ id: 'promo-used', code: 'USEDONCE' })
    const api = fakeApi([USED, TEN], { redeemed: [USED.id] })
    const user = userEvent.setup()
    renderPage()
    await rowOf(USED.id)

    await user.click(deleteOf(USED.id))
    const ask = await screen.findByTestId('admin-promotion-delete-dialog')
    expect(ask.textContent ?? '').toContain(`Delete ${USED.code}?`)
    await user.click(screen.getByTestId('admin-promotion-delete-confirm'))

    const alert = await screen.findByTestId('admin-promotions-error', undefined, { timeout: 5000 })
    await waitFor(() => expect(text(alert)).toBe(IN_USE))
    await aTurn()
    expect(alert).toHaveAttribute('role', 'alert')
    expect(api.of('DELETE').map((d) => d.path)).toEqual([`/api/admin/promotions/${USED.id}`])
    expect(
      screen.queryByTestId(`admin-promotions-row-${USED.id}`),
      'the used code’s row',
    ).not.toBeNull()
    expect(text(screen.queryByTestId('admin-promotions-result')), 'an outcome line').not.toMatch(
      /^Deleted/,
    )
  })

  it('AC-8: Delete of an unused code, confirmed, reads the list again; the row leaves and the result reads "Deleted <code>"', async () => {
    const SPARE = promotion({ id: 'promo-spare', code: 'SPARECODE' })
    const api = fakeApi([SPARE, TEN])
    const user = userEvent.setup()
    renderPage()
    await rowOf(SPARE.id)
    const readsBefore = api.listGets().length

    await user.click(deleteOf(SPARE.id))
    const ask = await screen.findByTestId('admin-promotion-delete-dialog')
    expect(ask.textContent ?? '').toContain(`Delete ${SPARE.code}?`)
    await user.click(screen.getByTestId('admin-promotion-delete-confirm'))

    await waitFor(() =>
      expect(text(screen.getByTestId('admin-promotions-result'))).toBe(`Deleted ${SPARE.code}`),
    )
    await waitFor(() => expect(screen.queryByTestId(`admin-promotions-row-${SPARE.id}`)).toBeNull())
    expect(api.listGets().length, 'list reads after the delete').toBeGreaterThan(readsBefore)
    expect(api.of('DELETE').map((d) => d.path)).toEqual([`/api/admin/promotions/${SPARE.id}`])
    expect(screen.queryByTestId(`admin-promotions-row-${TEN.id}`), 'the other row').not.toBeNull()
  })
})
