import fc from 'fast-check'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NymbalApiError, type NymbalClient } from '@nymbalhq/sdk'
import { setupMockClient } from '../testing/index.js'

// Sign-up on a store that confirms addresses, in the elements. The register form, told the link was sent, replaces
// itself with a "we sent a link" note naming the address and says so in an event, never that the shopper signed in.
// The verify element takes the link's token from the URL's fragment and out of the address bar at once, and sends
// nothing until the shopper presses its button (a mail scanner that runs scripts must not use the link); one press, or
// many, is one call; with no token, or once the store refuses the link, it offers to send the link again, and that
// form answers every request with one text.

interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

const CUSTOMER = {
  id: 'cus-verify',
  email: 'ada@verify.test',
  firstName: 'Ada',
  lastName: 'Lovelace',
  phone: '',
  addresses: [],
  orderCount: 0,
  totalSpentMinor: 0,
  metadata: {},
  roles: ['customer'],
  requiresPasswordReset: false,
  createdAt: '2026-11-10T00:00:00.000Z',
  updatedAt: '2026-11-10T00:00:00.000Z',
}

function auth(client: NymbalClient): Record<string, unknown> & { setState(partial: object): void } {
  return client.auth as unknown as Record<string, unknown> & { setState(partial: object): void }
}

/** Puts `fragment` in the address bar, as a mail's link opens the page. */
function openWithFragment(fragment: string): void {
  history.replaceState(null, '', `${location.pathname}${fragment}`)
}

afterEach(() => {
  openWithFragment('')
  document.body.innerHTML = ''
})

async function settled(el: Element): Promise<void> {
  await (el as Element & { updateComplete?: Promise<unknown> }).updateComplete
}

function deepAll(root: ParentNode, selector: string): Element[] {
  const found = [...root.querySelectorAll(selector)]
  for (const node of root.querySelectorAll('*')) {
    if (node.shadowRoot) found.push(...deepAll(node.shadowRoot, selector))
  }
  return found
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

function byTestId<T extends Element>(el: Element, id: string): T | undefined {
  const root = el.shadowRoot
  if (root === null) throw new Error(`<${el.localName}> has no open shadow root`)
  return deepAll(root, `[data-testid="${id}"]`)[0] as T | undefined
}

function required<T extends Element>(el: Element, id: string): T {
  const found = byTestId<T>(el, id)
  if (found === undefined) throw new Error(`<${el.localName}> renders no [data-testid="${id}"]`)
  return found
}

const textOf = (el: Element, id: string): string | null =>
  byTestId(el, id)?.textContent?.replace(/\s+/g, ' ').trim() ?? null

function type(el: Element, id: string, value: string): void {
  const field = required<HTMLInputElement>(el, id)
  field.value = value
  field.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
  field.dispatchEvent(new Event('change', { bubbles: true, composed: true }))
}

async function mounted(tag: string): Promise<HTMLElement> {
  if (customElements.get(tag) === undefined) {
    throw new Error(`<${tag}> is not defined by registerComponents()`)
  }
  const el = document.createElement(tag)
  document.body.appendChild(el)
  await flush(el)
  return el
}

/** The events of `names` the document hears while `run` runs, in order. */
async function heard<T>(
  names: string[],
  run: () => Promise<T>,
): Promise<{ result: T; events: Array<[string, unknown]> }> {
  const events: Array<[string, unknown]> = []
  const listener = (e: Event) => events.push([e.type, (e as CustomEvent).detail])
  for (const name of names) document.addEventListener(name, listener)
  try {
    return { result: await run(), events }
  } finally {
    for (const name of names) document.removeEventListener(name, listener)
  }
}

const SIGNED_IN = 'nymbal:auth:signed-in'
const SENT_EVENT = 'nymbal:auth:verification-sent'

const email = fc
  .tuple(fc.stringMatching(/^[a-z]{1,8}$/), fc.stringMatching(/^[a-z]{1,8}$/))
  .map(([user, host]) => `${user}@${host}.test`)
const password = fc.stringMatching(/^[A-Za-z0-9]{8,16}$/)
const token = fc.stringMatching(/^[A-Za-z0-9_-]{43}$/)

describe('AC-17: the register form, told the link was sent, says so and signs nobody in', () => {
  // Defect: the store shows a signed-in shell after a register that holds no session.
  it('AC-17: property: when register answers verification-sent, the form is replaced by register-sent naming the typed address and 24 hours, nymbal:auth:verification-sent carries the address, and nymbal:auth:signed-in is never emitted', async () => {
    await fc.assert(
      fc.asyncProperty(email, password, async (address, secret) => {
        document.body.innerHTML = ''
        const client = setupMockClient()
        auth(client)['register'] = vi.fn(async () => 'verification-sent')
        const el = await mounted('nymbal-register-form')

        const { events } = await heard([SIGNED_IN, SENT_EVENT], async () => {
          type(el, 'register-email', address)
          type(el, 'register-password', secret)
          type(el, 'register-confirmPassword', secret)
          required<HTMLButtonElement>(el, 'register-submit').click()
          await flush(el)
        })

        const note = textOf(el, 'register-sent')
        expect(note, 'register-sent is shown').not.toBeNull()
        expect(note).toContain(address)
        expect(note).toMatch(/24 hours/)
        expect(byTestId(el, 'register-form')).toBeUndefined()
        expect(events).toEqual([[SENT_EVENT, { email: address }]])
      }),
      { numRuns: 15 },
    )
  })
})

describe('AC-17: the verify element needs a press and keeps the token out of the URL', () => {
  // Defect: a mail scanner that runs scripts uses the link before the shopper does; the token stays in the address bar.
  it('AC-17: property: opened with #token=<t>, nymbal-verify-email leaves no token in the URL once rendered and calls nothing; a press of verify-submit calls verifyEmail(t) once and emits nymbal:auth:signed-in', async () => {
    await fc.assert(
      fc.asyncProperty(token, async (t) => {
        document.body.innerHTML = ''
        openWithFragment(`#token=${t}`)
        const client = setupMockClient()
        const call = vi.fn(async () => {
          auth(client).setState({ customer: CUSTOMER, isAuthenticated: true })
        })
        auth(client)['verifyEmail'] = call
        const el = await mounted('nymbal-verify-email')
        const urlAfterRender = location.href
        const callsBeforePress = call.mock.calls.length

        const { events } = await heard([SIGNED_IN], async () => {
          required<HTMLButtonElement>(el, 'verify-submit').click()
          await flush(el)
        })

        expect(urlAfterRender.includes(t), urlAfterRender).toBe(false)
        expect(location.hash).toBe('')
        expect(callsBeforePress).toBe(0)
        expect(call.mock.calls).toEqual([[t]])
        expect(events.map(([name]) => name)).toEqual([SIGNED_IN])
      }),
      { numRuns: 15 },
    )
  })

  // Defect: a double click sends twice.
  it('AC-17: property: k = 1-5 presses of verify-submit, and of resend-submit, while the first call is pending make one call each', async () => {
    await fc.assert(
      fc.asyncProperty(token, email, fc.integer({ min: 1, max: 5 }), async (t, address, k) => {
        document.body.innerHTML = ''
        openWithFragment(`#token=${t}`)
        const verifyHeld = deferred()
        const resendHeld = deferred()
        const client = setupMockClient()
        const verifyCall = vi.fn(async () => {
          await verifyHeld.promise
          throw new NymbalApiError('auth.verify_link_invalid', 'This link is no longer valid.', 400)
        })
        const resendCall = vi.fn(async () => {
          await resendHeld.promise
        })
        auth(client)['verifyEmail'] = verifyCall
        auth(client)['resendVerification'] = resendCall
        const el = await mounted('nymbal-verify-email')

        const verifyButton = required<HTMLButtonElement>(el, 'verify-submit')
        for (let i = 0; i < k; i += 1) {
          verifyButton.click()
          await flush(el)
        }
        verifyHeld.resolve()
        await flush(el)
        type(el, 'resend-email', address)
        const resendButton = required<HTMLButtonElement>(el, 'resend-submit')
        for (let i = 0; i < k; i += 1) {
          resendButton.click()
          await flush(el)
        }
        resendHeld.resolve()
        await flush(el)

        expect([verifyCall.mock.calls, resendCall.mock.calls], `${k} presses`).toEqual([
          [[t]],
          [[address]],
        ])
      }),
      { numRuns: 15 },
    )
  })

  // Defect: a page with no token, or a refused one, offers a button that can never work and no way to a new link.
  it('AC-17: with no token the element shows the resend form and no verify-submit; with a token it shows no verify-invalid until the store answers auth.verify_link_invalid, after which it shows verify-invalid and the resend form', async () => {
    openWithFragment('')
    setupMockClient()
    const tokenless = await mounted('nymbal-verify-email')
    const withoutToken = {
      resend: byTestId(tokenless, 'resend-email') !== undefined,
      submit: byTestId(tokenless, 'verify-submit') !== undefined,
    }

    document.body.innerHTML = ''
    openWithFragment(`#token=${'a'.repeat(43)}`)
    const client = setupMockClient()
    auth(client)['verifyEmail'] = vi.fn(async () => {
      throw new NymbalApiError('auth.verify_link_invalid', 'This link is no longer valid.', 400)
    })
    const refused = await mounted('nymbal-verify-email')
    const beforeAnswer = byTestId(refused, 'verify-invalid')
    required<HTMLButtonElement>(refused, 'verify-submit').click()
    await flush(refused)

    expect(withoutToken).toEqual({ resend: true, submit: false })
    expect(beforeAnswer).toBeUndefined()
    expect([
      byTestId(refused, 'verify-invalid') !== undefined,
      byTestId(refused, 'resend-email') !== undefined,
    ]).toEqual([true, true])
  })
})

describe('AC-17: the resend form answers one way', () => {
  // Defect: the page's state tells a pending address from an unknown one.
  it('AC-17: property: resend-sent shows the same text whatever address was asked for and whether the call resolved or was refused', async () => {
    const sentText = async (
      address: string,
      outcome: 'resolved' | 'refused',
    ): Promise<string | null> => {
      document.body.innerHTML = ''
      openWithFragment('')
      const client = setupMockClient()
      auth(client)['resendVerification'] = vi.fn(async () => {
        if (outcome === 'refused')
          throw new NymbalApiError('rate_limit.block', 'Too many requests', 429)
      })
      const el = await mounted('nymbal-verify-email')
      type(el, 'resend-email', address)
      required<HTMLButtonElement>(el, 'resend-submit').click()
      await flush(el)
      return textOf(el, 'resend-sent')
    }

    await fc.assert(
      fc.asyncProperty(email, email, async (first, second) => {
        const texts = [
          await sentText(first, 'resolved'),
          await sentText(second, 'resolved'),
          await sentText(second, 'refused'),
        ]

        expect(texts[0], 'resend-sent is shown').not.toBeNull()
        expect(texts).toEqual([texts[0], texts[0], texts[0]])
      }),
      { numRuns: 15 },
    )
  })
})
