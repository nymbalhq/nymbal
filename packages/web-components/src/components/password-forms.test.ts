import fc from 'fast-check'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NymbalApiError, type NymbalClient } from '@nymbalhq/sdk'
import { setupMockClient } from '../testing/index.js'

// The three password forms: ask for a reset link, set a password with the link's token, change a password while signed
// in. Each makes one SDK call per submission, however fast the shopper presses, with the fields as typed. The reset
// form takes its token from the URL's fragment and takes it out of the address bar at once, so it is in no history
// entry and no copied URL; with no token, or once the store refuses the link, it says the link is no good and links to
// the forgot page. The forgot form answers every request with one text, whoever's address it was.

const FORGOT_PATH = '/account/forgot-password'

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
  id: 'cus-ac23',
  email: 'ada@ac23.test',
  firstName: 'Ada',
  lastName: 'Lovelace',
  phone: '',
  addresses: [],
  orderCount: 0,
  totalSpentMinor: 0,
  metadata: {},
  roles: ['customer'],
  requiresPasswordReset: false,
  createdAt: '2026-11-09T00:00:00.000Z',
  updatedAt: '2026-11-09T00:00:00.000Z',
}

type Mock = ReturnType<typeof vi.fn>

function auth(client: NymbalClient): Record<string, unknown> & { setState(partial: object): void } {
  return client.auth as unknown as Record<string, unknown> & { setState(partial: object): void }
}

/** Puts `fragment` in the address bar, as a mail's link opens the page. */
function openWithFragment(fragment: string): void {
  history.replaceState(null, '', `${location.pathname}${fragment}`)
}

afterEach(() => {
  openWithFragment('')
})

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

function deepAll(root: ParentNode, selector: string): Element[] {
  const found = [...root.querySelectorAll(selector)]
  for (const node of root.querySelectorAll('*')) {
    if (node.shadowRoot) found.push(...deepAll(node.shadowRoot, selector))
  }
  return found
}

function deepByTestId<T extends Element>(el: Element, id: string): T | undefined {
  const root = el.shadowRoot
  if (root === null) throw new Error(`<${el.localName}> has no open shadow root`)
  return deepAll(root, `[data-testid="${id}"]`)[0] as T | undefined
}

function required<T extends Element>(el: Element, id: string): T {
  const found = deepByTestId<T>(el, id)
  if (found === undefined) throw new Error(`<${el.localName}> renders no [data-testid="${id}"]`)
  return found
}

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

interface FormCase {
  tag: string
  submit: string
  /** The page's fragment when it opens: the reset form's token. */
  fragment(token: string): string
  fields: fc.Arbitrary<Record<string, string>>
  method: 'requestPasswordReset' | 'resetPassword' | 'changePassword'
  signedIn: boolean
  args(fields: Record<string, string>, token: string): unknown[]
}

const email = fc
  .tuple(fc.stringMatching(/^[a-z]{1,8}$/), fc.stringMatching(/^[a-z]{1,8}$/))
  .map(([user, host]) => `${user}@${host}.test`)
const password = fc.stringMatching(/^[A-Za-z0-9]{8,16}$/)
const token = fc.stringMatching(/^[A-Za-z0-9_-]{43}$/)

const CASES: FormCase[] = [
  {
    tag: 'nymbal-forgot-password-form',
    submit: 'forgot-submit',
    fragment: () => '',
    fields: fc.record({ 'forgot-email': email }),
    method: 'requestPasswordReset',
    signedIn: false,
    args: (f) => [f['forgot-email']],
  },
  {
    tag: 'nymbal-reset-password-form',
    submit: 'reset-submit',
    fragment: (t) => `#token=${t}`,
    fields: fc.record({ 'reset-password': password }),
    method: 'resetPassword',
    signedIn: false,
    args: (f, t) => [t, f['reset-password']],
  },
  {
    tag: 'nymbal-change-password-form',
    submit: 'change-submit',
    fragment: () => '',
    fields: fc.record({ 'change-current': password, 'change-new': password }),
    method: 'changePassword',
    signedIn: true,
    args: (f) => [f['change-current'], f['change-new']],
  },
]

/** The form's SDK method, answering through `held`. */
function rig(form: FormCase, held: Deferred): Mock {
  const client = setupMockClient()
  if (form.signedIn) auth(client).setState({ customer: CUSTOMER, isAuthenticated: true })
  const call = vi.fn(async () => {
    await held.promise
    if (form.method === 'resetPassword') {
      auth(client).setState({ customer: CUSTOMER, isAuthenticated: true })
    }
  })
  auth(client)[form.method] = call
  return call
}

describe('AC-23: each password form makes one SDK call per submission, with what was typed', () => {
  for (const form of CASES) {
    it(`AC-23: property: ${form.tag}: k = 1-5 submits while the first call is pending make one ${form.method} call carrying the typed fields`, async () => {
      await fc.assert(
        fc.asyncProperty(
          form.fields,
          token,
          fc.integer({ min: 1, max: 5 }),
          async (fields, t, k) => {
            document.body.innerHTML = ''
            openWithFragment(form.fragment(t))
            const held = deferred()
            const call = rig(form, held)
            const el = await mounted(form.tag)
            for (const [id, value] of Object.entries(fields)) type(el, id, value)
            await flush(el)

            const submit = required<HTMLButtonElement>(el, form.submit)
            const formEl = submit.closest('form')
            submit.click()
            await flush(el)
            for (let i = 1; i < k; i += 1) {
              formEl?.requestSubmit()
              await flush(el)
            }
            held.resolve()
            await flush(el)

            expect(call.mock.calls, `${k} submits`).toEqual([form.args(fields, t)])
          },
        ),
        { numRuns: 20 },
      )
    })
  }
})

describe('AC-23: the reset form keeps its token out of the address bar', () => {
  // Defect: the token stays in the address bar, in history and in a copied URL.
  it('AC-23: property: opened with #token=<t>, the form leaves no token in the URL once it has rendered, and its submission still carries t', async () => {
    await fc.assert(
      fc.asyncProperty(token, password, async (t, p) => {
        document.body.innerHTML = ''
        openWithFragment(`#token=${t}`)
        const held = deferred()
        held.resolve()
        const call = rig(CASES[1]!, held)
        const el = await mounted('nymbal-reset-password-form')
        const urlAfterRender = location.href

        type(el, 'reset-password', p)
        required<HTMLButtonElement>(el, 'reset-submit').click()
        await flush(el)

        expect(urlAfterRender.includes(t), urlAfterRender).toBe(false)
        expect(location.hash).toBe('')
        expect(call.mock.calls).toEqual([[t, p]])
      }),
      { numRuns: 15 },
    )
  })

  // Defect: a page with no token, or a refused one, offers a form that can never work and no way to a new link.
  it('AC-23: with no token the form shows reset-invalid linking to the forgot page; with a token it does not, until the store answers auth.reset_link_invalid, after which it does', async () => {
    const forgotLink = (el: Element) =>
      deepByTestId<HTMLElement>(el, 'reset-invalid')
        ?.querySelector<HTMLAnchorElement>('a[href]')
        ?.getAttribute('href') ?? null

    document.body.innerHTML = ''
    openWithFragment('')
    rig(CASES[1]!, deferred())
    const tokenless = await mounted('nymbal-reset-password-form')
    const withoutToken = forgotLink(tokenless)

    document.body.innerHTML = ''
    openWithFragment(`#token=${'a'.repeat(43)}`)
    const client = setupMockClient()
    auth(client)['resetPassword'] = vi.fn(async () => {
      throw new NymbalApiError('auth.reset_link_invalid', 'This link is no longer valid.', 400)
    })
    const refused = await mounted('nymbal-reset-password-form')
    const beforeAnswer = deepByTestId(refused, 'reset-invalid')
    type(refused, 'reset-password', 'a-new-password-1')
    required<HTMLButtonElement>(refused, 'reset-submit').click()
    await flush(refused)

    expect(withoutToken?.endsWith(FORGOT_PATH), `reset-invalid link: ${withoutToken}`).toBe(true)
    expect(beforeAnswer).toBeUndefined()
    expect(forgotLink(refused)).toBe(withoutToken)
  })
})

describe('AC-23: the forgot form answers one way', () => {
  // Defect: the page's state tells a registered address from an unknown one.
  it('AC-23: property: forgot-sent shows the same text whatever address was asked for and whether the call resolved or was refused', async () => {
    const sentText = async (
      address: string,
      outcome: 'resolved' | 'refused',
    ): Promise<string | null> => {
      document.body.innerHTML = ''
      const client = setupMockClient()
      auth(client)['requestPasswordReset'] = vi.fn(async () => {
        if (outcome === 'refused')
          throw new NymbalApiError('rate_limit.block', 'Too many requests', 429)
      })
      const el = await mounted('nymbal-forgot-password-form')
      type(el, 'forgot-email', address)
      required<HTMLButtonElement>(el, 'forgot-submit').click()
      await flush(el)
      return deepByTestId<HTMLElement>(el, 'forgot-sent')?.textContent?.trim() ?? null
    }

    await fc.assert(
      fc.asyncProperty(email, email, async (first, second) => {
        const texts = [
          await sentText(first, 'resolved'),
          await sentText(second, 'resolved'),
          await sentText(second, 'refused'),
        ]

        expect(texts[0], 'forgot-sent is shown').not.toBeNull()
        expect(texts).toEqual([texts[0], texts[0], texts[0]])
      }),
      { numRuns: 15 },
    )
  })
})
