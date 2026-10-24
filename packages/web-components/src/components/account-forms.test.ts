import fc from 'fast-check'
import { describe, expect, it, vi } from 'vitest'
import type { NymbalClient } from '@nymbalhq/sdk'
import { setupMockClient } from '../testing/index.js'

// AC-4: each account form makes exactly one SDK call per submission. The shopper clicks submit, then the form is
// submitted k - 1 more times (`requestSubmit()`, which fires `submit` even while the control is disabled) while that
// first call is pending. The call carries the form's fields; while it is pending the control is disabled; once it
// succeeds the form's event fires once and the control re-enables, except on login and register, whose page navigates
// away: their control stays disabled through the redirect; once it fails the error text shows, the control re-enables
// and no event fires. Register also asks for the password twice and a mismatch makes no call.

interface Deferred {
  promise: Promise<void>
  resolve(): void
  reject(err: Error): void
}

function deferred(): Deferred {
  let resolve!: () => void
  let reject!: (err: Error) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const CUSTOMER = {
  id: 'cus-ac4',
  email: 'ada@ac4.test',
  firstName: 'Ada',
  lastName: 'Lovelace',
  phone: '+44 7700 900000',
  addresses: [],
  orderCount: 0,
  totalSpentMinor: 0,
  metadata: {},
  roles: ['customer'],
  requiresPasswordReset: false,
  createdAt: '2026-10-21T00:00:00.000Z',
  updatedAt: '2026-10-21T00:00:00.000Z',
}

type Mock = ReturnType<typeof vi.fn>

/** The SDK the forms reach, with the call under test answering through `held`. */
interface Rig {
  client: NymbalClient
  call: Mock
}

interface FormCase {
  tag: string
  submitTestId: string
  event: string
  /** Field test id → the value the shopper types. */
  fields: fc.Arbitrary<Record<string, string>>
  /** Installs the SDK the form needs and returns the method under test, answering through `held`. */
  rig(held: Deferred): Rig
  /** The arguments the call must carry for those fields. */
  args(fields: Record<string, string>): unknown[]
  /** Whether the error text for `err` is shown, given the element's text before and after the failure. */
  showsError(before: string, after: string, err: Error): boolean
  /** Checks a success event's detail. */
  detail?(detail: unknown): void
  /** The submit stays disabled after a success, because the page navigates away on it. */
  locksOnSuccess?: boolean
}

const word = fc.stringMatching(/^[A-Z][a-z]{1,9}$/)
const email = fc
  .tuple(fc.stringMatching(/^[a-z]{1,8}$/), fc.stringMatching(/^[a-z]{1,8}$/))
  .map(([user, host]) => `${user}@${host}.test`)
const password = fc.stringMatching(/^[A-Za-z0-9]{8,16}$/)
const phone = fc.stringMatching(/^\+44 7700 9[0-9]{5}$/)

function auth(client: NymbalClient): Record<string, unknown> & {
  setState(partial: object): void
} {
  return client.auth as unknown as Record<string, unknown> & { setState(partial: object): void }
}

/** The address SDK the address book lists from and creates through. */
function installAddresses(client: NymbalClient, create: Mock): void {
  ;(client as unknown as Record<string, unknown>)['customer'] = {
    addresses: {
      list: vi.fn(async () => []),
      create,
      remove: vi.fn(async () => undefined),
    },
    orders: {
      list: vi.fn(async () => ({ items: [], nextCursor: null })),
      get: vi.fn(async () => {
        throw new Error('No order')
      }),
    },
  }
}

const shows = (_before: string, after: string, err: Error): boolean => after.includes(err.message)

const signedInDetail = (detail: unknown): void => {
  expect((detail as { customer?: unknown } | null)?.customer).toEqual(CUSTOMER)
}

const CASES: FormCase[] = [
  {
    tag: 'nymbal-login-form',
    submitTestId: 'login-submit',
    event: 'nymbal:auth:signed-in',
    fields: fc.record({ 'login-email': email, 'login-password': password }),
    rig(held) {
      const client = setupMockClient()
      const call = vi.fn(async () => {
        await held.promise
        auth(client).setState({ customer: CUSTOMER, isAuthenticated: true })
      })
      auth(client)['login'] = call
      return { client, call }
    },
    args: (f) => [f['login-email'], f['login-password']],
    showsError: shows,
    detail: signedInDetail,
    locksOnSuccess: true,
  },
  {
    tag: 'nymbal-register-form',
    submitTestId: 'register-submit',
    event: 'nymbal:auth:signed-in',
    fields: fc
      .record({
        'register-email': email,
        'register-password': password,
        'register-firstName': word,
        'register-lastName': word,
        'register-phone': phone,
      })
      .map((f) => ({ ...f, 'register-confirmPassword': f['register-password'] })),
    rig(held) {
      const client = setupMockClient()
      const call = vi.fn(async () => {
        await held.promise
        auth(client).setState({ customer: CUSTOMER, isAuthenticated: true })
      })
      auth(client)['register'] = call
      return { client, call }
    },
    args: (f) => [
      {
        email: f['register-email'],
        password: f['register-password'],
        firstName: f['register-firstName'],
        lastName: f['register-lastName'],
        phone: f['register-phone'],
      },
    ],
    showsError: shows,
    detail: signedInDetail,
    locksOnSuccess: true,
  },
  {
    tag: 'nymbal-profile-form',
    submitTestId: 'profile-save',
    event: 'nymbal:profile:saved',
    fields: fc.record({
      'profile-firstName': word,
      'profile-lastName': word,
      'profile-phone': phone,
    }),
    rig(held) {
      const client = setupMockClient()
      auth(client).setState({ customer: CUSTOMER, isAuthenticated: true })
      auth(client)['loadProfile'] = vi.fn(async () => undefined)
      const call = vi.fn(() => held.promise)
      auth(client)['updateProfile'] = call
      return { client, call }
    },
    args: (f) => [
      {
        firstName: f['profile-firstName'],
        lastName: f['profile-lastName'],
        phone: f['profile-phone'],
      },
    ],
    showsError: shows,
  },
  {
    tag: 'nymbal-address-book',
    submitTestId: 'save-address',
    event: 'nymbal:address-book:changed',
    // The add form's fields keep the test ids the account journeys fill (`account-signed-in.spec.ts:89-95`).
    fields: fc.record({
      'new-address-firstName': word,
      'new-address-lastName': word,
      'new-address-addressLine1': word.map((w) => `1 ${w} Row`),
      'new-address-addressLine2': word.map((w) => `Flat ${w}`),
      'new-address-city': word,
      'new-address-region': word,
      'new-address-postalCode': fc.stringMatching(/^E[1-9] [1-9]AN$/),
      'new-address-country': fc.constantFrom('GB', 'FR'),
    }),
    rig(held) {
      const client = setupMockClient()
      auth(client).setState({ customer: CUSTOMER, isAuthenticated: true })
      const call = vi.fn(async (address: Record<string, unknown>) => {
        await held.promise
        return { ...address, id: 'addr-new', isDefaultBilling: false, isDefaultShipping: false }
      })
      installAddresses(client, call)
      return { client, call }
    },
    args: (f) => [
      {
        firstName: f['new-address-firstName'],
        lastName: f['new-address-lastName'],
        addressLine1: f['new-address-addressLine1'],
        addressLine2: f['new-address-addressLine2'],
        city: f['new-address-city'],
        region: f['new-address-region'],
        postalCode: f['new-address-postalCode'],
        country: f['new-address-country'],
      },
    ],
    // Today's add-address failure text is the page's own ("Failed to save address…"), not the error's message.
    showsError: (before, after, err) =>
      after.includes(err.message) ||
      (/fail|error|unable|could not/i.test(after) && !/fail|error|unable|could not/i.test(before)),
  },
]

async function settled(el: Element): Promise<void> {
  await (el as Element & { updateComplete?: Promise<unknown> }).updateComplete
}

/** Lets the element's handlers and renders run: every SDK fake answers within a few turns once released. */
async function flush(el: Element): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    await settled(el)
    for (const nested of deepAll(el.shadowRoot!, '*')) {
      if (nested.shadowRoot) await settled(nested)
    }
  }
}

/** Every element matching `selector` in `root` and in each open shadow root beneath it. */
function deepAll(root: ParentNode, selector: string): Element[] {
  const found = [...root.querySelectorAll(selector)]
  for (const node of root.querySelectorAll('*')) {
    if (node.shadowRoot) found.push(...deepAll(node.shadowRoot, selector))
  }
  return found
}

function deepByTestId<T extends Element>(el: Element, id: string): T {
  const root = el.shadowRoot
  if (root === null) throw new Error(`<${el.localName}> has no open shadow root`)
  const found = deepAll(root, `[data-testid="${id}"]`)[0]
  if (found === undefined) throw new Error(`<${el.localName}> renders no [data-testid="${id}"]`)
  return found as T
}

/** The text a shopper reads in the element: its shadow root and every shadow root nested in it. */
function deepText(el: Element): string {
  const parts: string[] = []
  const walk = (root: ParentNode): void => {
    parts.push(root.textContent ?? '')
    for (const node of root.querySelectorAll('*')) if (node.shadowRoot) walk(node.shadowRoot)
  }
  if (el.shadowRoot) walk(el.shadowRoot)
  return parts.join(' ')
}

function type(el: Element, id: string, value: string): void {
  const field = deepByTestId<HTMLInputElement>(el, id)
  field.value = value
  field.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
  field.dispatchEvent(new Event('change', { bubbles: true, composed: true }))
}

describe('the moved account forms call the SDK once per submission', () => {
  for (const form of CASES) {
    const afterSuccess = form.locksOnSuccess
      ? `keeps ${form.submitTestId} disabled`
      : `re-enables ${form.submitTestId}`
    it(`AC-4: property: ${form.tag}: k = 1-5 submits while the first call is pending make one call with the form’s fields; success fires ${form.event} once and ${afterSuccess}; failure shows the error, re-enables it and fires nothing`, async () => {
      expect(
        customElements.get(form.tag),
        `${form.tag} is defined by registerComponents()`,
      ).toBeDefined()
      await fc.assert(
        fc.asyncProperty(
          form.fields,
          fc.integer({ min: 1, max: 5 }),
          fc.boolean(),
          fc.stringMatching(/^[A-Z][a-z]{3,10} refused$/),
          async (fields, k, succeeds, message) => {
            document.body.innerHTML = ''
            const held = deferred()
            const { call } = form.rig(held)
            const events: unknown[] = []
            const listener = (e: Event) => events.push((e as CustomEvent).detail)
            document.addEventListener(form.event, listener)
            try {
              const el = document.createElement(form.tag)
              document.body.appendChild(el)
              await flush(el)
              for (const [id, value] of Object.entries(fields)) type(el, id, value)
              await flush(el)
              const before = deepText(el)

              const submit = deepByTestId<HTMLButtonElement>(el, form.submitTestId)
              const formEl = submit.closest('form')
              expect(formEl, `${form.submitTestId} sits in the element’s own <form>`).not.toBeNull()
              submit.click()
              await flush(el)
              for (let i = 1; i < k; i += 1) {
                formEl!.requestSubmit()
                await flush(el)
              }
              expect(call, `${k} submits while pending`).toHaveBeenCalledTimes(1)
              expect(call.mock.calls[0]).toEqual(form.args(fields))
              expect(
                deepByTestId<HTMLButtonElement>(el, form.submitTestId).disabled,
                'submit is disabled while the call is pending',
              ).toBe(true)

              const err = new Error(message)
              if (succeeds) held.resolve()
              else held.reject(err)
              await flush(el)

              const locked = succeeds && form.locksOnSuccess === true
              expect(
                deepByTestId<HTMLButtonElement>(el, form.submitTestId).disabled,
                locked
                  ? 'submit stays disabled after a success, through the redirect'
                  : 'submit re-enables once the call settles',
              ).toBe(locked)
              if (locked) {
                formEl!.requestSubmit()
                await flush(el)
              }
              expect(events, `${form.event} events`).toHaveLength(succeeds ? 1 : 0)
              for (const detail of events) form.detail?.(detail)
              // The error text shows after a failure, and only then.
              expect(
                form.showsError(before, deepText(el), err),
                `error text after ${succeeds ? 'success' : `"${message}"`}`,
              ).toBe(!succeeds)
              expect(call).toHaveBeenCalledTimes(1)
            } finally {
              document.removeEventListener(form.event, listener)
            }
          },
        ),
        { numRuns: 25 },
      )
    })
  }
})

describe('nymbal-register-form asks for the password twice', () => {
  it('property: a confirmation that differs from the password shows "Passwords do not match." and makes no register call; the submit re-enables', async () => {
    await fc.assert(
      fc.asyncProperty(email, password, password, async (address, first, second) => {
        fc.pre(first !== second)
        document.body.innerHTML = ''
        const client = setupMockClient()
        const call = vi.fn(async () => undefined)
        auth(client)['register'] = call
        const events: unknown[] = []
        const listener = (e: Event) => events.push(e)
        document.addEventListener('nymbal:auth:signed-in', listener)
        try {
          const el = document.createElement('nymbal-register-form')
          document.body.appendChild(el)
          await flush(el)
          type(el, 'register-email', address)
          type(el, 'register-password', first)
          type(el, 'register-confirmPassword', second)
          await flush(el)
          expect(deepText(el)).not.toContain('Passwords do not match.')

          deepByTestId<HTMLButtonElement>(el, 'register-submit').click()
          await flush(el)

          expect(call).not.toHaveBeenCalled()
          expect(events).toHaveLength(0)
          expect(deepText(el)).toContain('Passwords do not match.')
          expect(deepByTestId<HTMLButtonElement>(el, 'register-submit').disabled).toBe(false)
        } finally {
          document.removeEventListener('nymbal:auth:signed-in', listener)
        }
      }),
      { numRuns: 20 },
    )
  })
})
