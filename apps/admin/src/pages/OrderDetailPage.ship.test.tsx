import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import fc from 'fast-check'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import {
  STATUS_LABEL,
  fakeOrderApi,
  held,
  movedTo,
  orderIn,
  polyfillRadix,
  refusal,
  renderOrderPage,
} from '@/tests/order-page'

// Shipping an order from the admin: Mark Shipped and the status select's Shipped each ask for carrier and tracking
// number in a dialog, which posts them trimmed, once per click, and keeps what was typed when the server refuses.

/** What the API accepts as an Idempotency-Key: 1 to 128 of [A-Za-z0-9._:-]. */
const KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/
const DIALOG = 'admin-order-ship-dialog'
const CARRIER = 'admin-order-ship-carrier'
const TRACKING = 'admin-order-ship-tracking'
const SUBMIT = 'admin-order-ship-submit'
const CANCEL = 'admin-order-ship-cancel'
const ERROR = 'admin-order-ship-error'

type User = ReturnType<typeof userEvent.setup>

beforeAll(polyfillRadix)

afterEach(() => {
  vi.unstubAllGlobals()
})

async function openFromButton(user: User): Promise<HTMLElement> {
  await user.click(await screen.findByRole('button', { name: 'Mark Shipped' }, { timeout: 5000 }))
  return screen.findByTestId(DIALOG)
}

async function openFromSelect(user: User): Promise<HTMLElement> {
  await user.click(
    await screen.findByTestId('admin-order-status-select', undefined, { timeout: 5000 }),
  )
  await user.click(await screen.findByTestId('admin-order-status-option-shipped'))
  return screen.findByTestId(DIALOG)
}

function type(testId: string, value: string): void {
  fireEvent.change(screen.getByTestId(testId), { target: { value } })
}

describe('the ship dialog', () => {
  // Kills: Mark Shipped posting blank carrier and tracking (the API refuses them 400); a submit enabled on a value
  // that is only whitespace; values posted untrimmed; a dialog left open after the order shipped.
  it('AC-10: Mark Shipped opens the dialog and posts nothing; submit is disabled exactly while carrier or tracking is blank after trimming; submit posts one /ship with both trimmed and closes the dialog', async () => {
    const order = orderIn('processing')
    const api = fakeOrderApi(order, () => {
      api.setServer('shipped')
      return movedTo(order, 'shipped')
    })
    const user = userEvent.setup()
    renderOrderPage(order)

    const dialog = await openFromButton(user)
    expect(api.writesTo('ship').length, '/ship POSTs on opening the dialog').toBe(0)

    const blankOrText = fc.oneof(
      fc.constantFrom('', ' ', '   ', '\t', ' \t '),
      fc.string({ minLength: 1, maxLength: 12 }),
    )
    const submit = within(dialog).getByTestId(SUBMIT) as HTMLButtonElement
    fc.assert(
      fc.property(blankOrText, blankOrText, (carrier, tracking) => {
        type(CARRIER, carrier)
        type(TRACKING, tracking)
        expect(
          submit.disabled,
          `carrier ${JSON.stringify(carrier)}, tracking ${JSON.stringify(tracking)}`,
        ).toBe(carrier.trim() === '' || tracking.trim() === '')
      }),
      { numRuns: 60 },
    )

    type(CARRIER, '  Royal Mail ')
    type(TRACKING, ' RM123456785GB  ')
    await user.click(submit)

    await waitFor(() => expect(screen.queryByTestId(DIALOG)).toBeNull())
    const sent = api.writesTo('ship')
    expect(sent.length, '/ship POSTs').toBe(1)
    expect(sent[0]!.body).toMatchObject({ carrier: 'Royal Mail', trackingNumber: 'RM123456785GB' })
  })

  // Kills: the select posting /ship with no body; a dialog Cancel that still posts, or leaves the select on Shipped.
  it('AC-10: the select’s Shipped opens the dialog and posts nothing; Cancel, from the select or from Mark Shipped, posts nothing and the select shows the current status again', async () => {
    const order = orderIn('processing')
    const api = fakeOrderApi(order, () => movedTo(order, 'shipped'))
    const user = userEvent.setup()
    renderOrderPage(order)
    const select = await screen.findByTestId('admin-order-status-select', undefined, {
      timeout: 5000,
    })
    const shownBefore = select.textContent

    for (const open of [openFromSelect, openFromButton]) {
      const dialog = await open(user)
      expect(api.writesTo('ship').length, `/ship POSTs on opening (${open.name})`).toBe(0)
      type(CARRIER, 'DHL')
      type(TRACKING, 'JD014600006281')
      await user.click(within(dialog).getByTestId(CANCEL))
      await waitFor(() => expect(screen.queryByTestId(DIALOG)).toBeNull())
      expect(
        screen.getByTestId('admin-order-status-select').textContent,
        `after Cancel (${open.name})`,
      ).toBe(shownBefore)
    }
    expect(api.writes.length, 'writes of any kind').toBe(0)
  })

  // Kills: a rejection dropped (`void mutateAsync`), so the merchant sees nothing; a dialog that closes or clears
  // what was typed on a refusal.
  for (const status of [400, 409]) {
    it(`AC-11: /ship answered ${status} shows the answer’s message in the dialog, which stays open with what was typed`, async () => {
      const order = orderIn('processing')
      const message =
        status === 400
          ? 'trackingNumber and carrier required'
          : 'Order NYM-1001 cannot move from cancelled to shipped'
      const api = fakeOrderApi(order, () =>
        refusal(status, status === 400 ? 'orders.invalid' : 'order.invalid_transition', message),
      )
      const user = userEvent.setup()
      renderOrderPage(order)

      const dialog = await openFromButton(user)
      type(CARRIER, 'Evri')
      type(TRACKING, 'H01HYA0012345678')
      await user.click(within(dialog).getByTestId(SUBMIT))

      await waitFor(() => expect(api.answered).toBe(1))
      await waitFor(() => expect(screen.getByTestId(ERROR)).toHaveTextContent(message))
      expect(within(dialog).getByRole('alert')).toBe(screen.getByTestId(ERROR))
      expect([
        (screen.getByTestId(CARRIER) as HTMLInputElement).value,
        (screen.getByTestId(TRACKING) as HTMLInputElement).value,
      ]).toEqual(['Evri', 'H01HYA0012345678'])
    })
  }

  // Kills: the select rendering a bare status once the refusal's refetch leaves the order no moves, which unmounts the
  // dialog it opened with what was typed and the message.
  it('AC-11: from the select, /ship answered 409 because the order was refunded elsewhere keeps the dialog open with the answer’s message and what was typed once the refetch shows the order refunded', async () => {
    const order = orderIn('processing')
    const message = 'Order NYM-1001 cannot move from refunded to shipped'
    const api = fakeOrderApi(order, () => {
      api.setServer('refunded')
      return refusal(409, 'order.invalid_transition', message)
    })
    const user = userEvent.setup()
    renderOrderPage(order)

    const dialog = await openFromSelect(user)
    type(CARRIER, 'Evri')
    type(TRACKING, 'H01HYA0012345678')
    await user.click(within(dialog).getByTestId(SUBMIT))

    await waitFor(() => expect(api.answered).toBe(1))
    await waitFor(() =>
      expect(screen.getByTestId('admin-order-status-badge')).toHaveTextContent(
        STATUS_LABEL.refunded,
      ),
    )
    expect(screen.getByTestId(ERROR)).toHaveTextContent(message)
    expect(within(screen.getByTestId(DIALOG)).getByRole('alert')).toBe(screen.getByTestId(ERROR))
    expect([
      (screen.getByTestId(CARRIER) as HTMLInputElement).value,
      (screen.getByTestId(TRACKING) as HTMLInputElement).value,
    ]).toEqual(['Evri', 'H01HYA0012345678'])
  })

  // Kills: a guard on `isPending` alone (it reaches the button a render late), and a new Idempotency-Key per send.
  it('AC-12: two clicks on submit before the dialog re-renders send one /ship, with one key, and submit is disabled while it is in flight', async () => {
    const order = orderIn('processing')
    const gate = held(movedTo(order, 'shipped'))
    const api = fakeOrderApi(order, async () => {
      const a = await gate.answer()
      api.setServer('shipped')
      return a
    })
    const user = userEvent.setup()
    renderOrderPage(order)

    const dialog = await openFromButton(user)
    type(CARRIER, 'UPS')
    type(TRACKING, '1Z999AA10123456784')
    const submit = within(dialog).getByTestId(SUBMIT) as HTMLButtonElement
    act(() => {
      submit.click()
      submit.click()
    })
    await waitFor(() => expect(api.writesTo('ship').length).toBeGreaterThan(0))
    const sentInFlight = api.writesTo('ship').length
    const disabledInFlight = submit.disabled
    gate.release()
    await waitFor(() => expect(api.answered).toBe(api.writes.length))

    const sent = api.writesTo('ship')
    expect(sentInFlight, '/ship POSTs from two clicks').toBe(1)
    expect(sent.length, '/ship POSTs once settled').toBe(sentInFlight)
    expect(new Set(sent.map((w) => w.key)).size, `keys ${JSON.stringify(sent)}`).toBe(1)
    expect(sent[0]!.key, 'the Idempotency-Key sent').toMatch(KEY_PATTERN)
    expect(disabledInFlight, 'submit while its POST is in flight').toBe(true)
  })
})
