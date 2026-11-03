import fc from 'fast-check'
import { describe, expect, it, vi } from 'vitest'
import { NymbalApiError } from '@nymbalhq/sdk'
import { setupMockClient } from '../testing/index.js'

// AC-5: `nymbal-review-form` submits once per click through `client.adapter.reviews.submit`. The signed-in shopper fills the
// form and clicks submit, then the form is submitted k - 1 more times (`requestSubmit()`, which fires `submit` even
// while the button is disabled) while the first call is held. Exactly one call is made, with `{ productId, rating,
// title, body }`; `submit` is disabled while it is held; on success one `nymbal:review:submitted` fires with the
// review's id, the form resets and `submit` re-enables; on a refusal the `error` part shows, `submit` re-enables and
// nothing fires.

const TAG = 'nymbal-review-form'
const EVENT = 'nymbal:review:submitted'

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

async function settled(el: Element): Promise<void> {
  await (el as Element & { updateComplete?: Promise<unknown> }).updateComplete
}

/** Lets the element's handlers and renders run: the fake answers within a turn once released. */
async function flush(el: Element): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    await settled(el)
  }
}

function byTestId<T extends Element>(el: Element, id: string): T {
  const found = el.shadowRoot?.querySelector(`[data-testid="${id}"]`)
  if (found === null || found === undefined) {
    throw new Error(`<${el.localName}> renders no [data-testid="${id}"]`)
  }
  return found as T
}

/** The nodes carrying exactly this part token. */
function parts(el: Element, part: string): Element[] {
  return [...(el.shadowRoot?.querySelectorAll('[part]') ?? [])].filter((n) =>
    (n.getAttribute('part') ?? '').split(/\s+/).includes(part),
  )
}

/** The error text the shopper sees: the `error` part's text, unless it is hidden. */
const errorShown = (el: Element): string =>
  parts(el, 'error')
    .filter((n) => !n.hasAttribute('hidden'))
    .map((n) => (n.textContent ?? '').trim())
    .join(' ')
    .trim()

function type(el: Element, id: string, value: string): void {
  const field = byTestId<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(el, id)
  field.value = value
  field.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
  field.dispatchEvent(new Event('change', { bubbles: true, composed: true }))
}

const text = fc.stringMatching(/^[A-Z][a-z]{2,12}( [a-z]{2,8}){0,3}$/)

interface AuthStore {
  setState(partial: Record<string, unknown>): void
  loadProfile: () => Promise<void>
}

const authOf = (client: Record<string, unknown>): AuthStore => client['auth'] as AuthStore

/** The mock client's auth store holding a signed-in customer, as after a sign-in or a profile load. */
function signIn(client: Record<string, unknown>): void {
  authOf(client).setState({
    customer: { id: 'cus-review', email: 'ada@reviews.test', firstName: 'Ada', lastName: 'Lovelace' },
    isAuthenticated: true,
    loading: false,
  })
}

describe('AC-5: the review form submits once per click', () => {
  it('AC-5: property: k = 1-5 submits while the first call is held make one reviews.submit call with the form’s fields; submit is disabled while held; success fires nymbal:review:submitted once with the review id, resets the form and re-enables submit; a refusal shows the error part, re-enables submit and fires nothing', async () => {
    expect(customElements.get(TAG), `${TAG} is defined by registerComponents()`).toBeDefined()
    await fc.assert(
      fc.asyncProperty(
        fc.stringMatching(/^prod-[a-z0-9]{4,8}$/),
        fc.integer({ min: 1, max: 5 }),
        text,
        text,
        fc.integer({ min: 1, max: 5 }),
        fc.boolean(),
        fc.stringMatching(/^[A-Z][a-z]{3,10} refused$/),
        async (productId, rating, title, body, k, succeeds, message) => {
          document.body.innerHTML = ''
          const held = deferred()
          const client = setupMockClient() as unknown as Record<string, unknown>
          signIn(client)
          const reviewId = `rev-${productId}`
          const submit = vi.fn(async (review: Record<string, unknown>) => {
            await held.promise
            return { review: { ...review, id: reviewId, moderationStatus: 'pending' } }
          })
          client['adapter'] = {
            reviews: { submit, getForProduct: async () => ({ items: [], nextCursor: null }) },
          }
          const events: unknown[] = []
          const listener = (e: Event): void => {
            events.push((e as CustomEvent).detail)
          }
          document.addEventListener(EVENT, listener)
          try {
            const el = document.createElement(TAG)
            el.setAttribute('product-id', productId)
            document.body.append(el)
            await flush(el)
            type(el, 'review-rating', String(rating))
            type(el, 'review-title', title)
            type(el, 'review-body', body)
            await flush(el)

            const button = byTestId<HTMLButtonElement>(el, 'review-submit')
            const form = button.closest('form')
            expect(form, 'review-submit sits in the element’s own <form>').not.toBeNull()
            button.click()
            for (let i = 1; i < k; i += 1) form!.requestSubmit()
            await flush(el)

            expect(submit, `${k} submits while held`).toHaveBeenCalledTimes(1)
            expect(submit.mock.calls[0]).toEqual([{ productId, rating, title, body }])
            expect(
              byTestId<HTMLButtonElement>(el, 'review-submit').disabled,
              'disabled while held',
            ).toBe(true)

            if (succeeds) held.resolve()
            else held.reject(new Error(message))
            await flush(el)

            expect(
              byTestId<HTMLButtonElement>(el, 'review-submit').disabled,
              'submit re-enabled',
            ).toBe(false)
            expect(events).toEqual(succeeds ? [{ reviewId }] : [])
            // Success resets the form and shows no error; a refusal shows the error part.
            const after = {
              fields: {
                title: byTestId<HTMLInputElement>(el, 'review-title').value,
                body: byTestId<HTMLTextAreaElement>(el, 'review-body').value,
              },
              error: errorShown(el) !== '',
            }
            const anyFields: unknown = expect.anything()
            expect(after).toEqual(
              succeeds
                ? { fields: { title: '', body: '' }, error: false }
                : { fields: anyFields, error: true },
            )
            expect(submit).toHaveBeenCalledTimes(1)
          } finally {
            document.removeEventListener(EVENT, listener)
          }
        },
      ),
      { numRuns: 25 },
    )
  })
})

// AC-11: the form follows the auth store. While the shopper is not known to be signed out (a profile load in flight)
// it is the form, as the server rendered it; once the profile load settles signed out it is only a sign-in link back
// to this page; signed in it is the form. A refusal shows the store's own words when they are about the review or the
// session, and an ended session turns the form into the sign-in link; anything else shows the generic text.

const FORM_PARTS = ['body', 'form', 'rating', 'submit', 'title']
const GENERIC = 'Something went wrong. Please try again.'

type Auth = 'loading' | 'signed-out' | 'signed-in'

/** A client whose profile load is held (`loading`), settles signed out, or finds the customer signed in already. */
function clientIn(auth: Auth): { client: Record<string, unknown>; release: () => void; loads: () => number } {
  const client = setupMockClient() as unknown as Record<string, unknown>
  const store = authOf(client)
  const held = deferred()
  let loads = 0
  if (auth === 'signed-in') signIn(client)
  if (auth === 'loading') store.setState({ loading: true })
  store.loadProfile = async () => {
    loads += 1
    if (auth === 'loading') await held.promise
    store.setState({ loading: false })
  }
  return {
    client,
    release: () => held.resolve(),
    loads: () => loads,
  }
}

async function mounted(productId = 'p1'): Promise<HTMLElement> {
  const el = document.createElement(TAG)
  el.setAttribute('product-id', productId)
  document.body.append(el)
  await flush(el)
  return el
}

/** Every part token the element renders, sorted, each once. */
function renderedParts(el: Element): string[] {
  const all = [...(el.shadowRoot?.querySelectorAll('[part]') ?? [])].flatMap((n) =>
    (n.getAttribute('part') ?? '').split(/\s+/).filter((p) => p !== ''),
  )
  return [...new Set(all)].sort()
}

const signInLink = (el: Element): HTMLAnchorElement | null =>
  el.shadowRoot?.querySelector<HTMLAnchorElement>('[data-testid="review-sign-in"]') ?? null

/** Fills and submits the form, with `reviews.submit` refusing with `error`. */
async function refusedWith(error: Error): Promise<HTMLElement> {
  const { client } = clientIn('signed-in')
  client['adapter'] = {
    reviews: {
      submit: async () => {
        throw error
      },
      getForProduct: async () => ({ items: [], nextCursor: null }),
    },
  }
  const el = await mounted()
  type(el, 'review-rating', '4')
  type(el, 'review-title', 'Solid')
  type(el, 'review-body', 'It works.')
  await flush(el)
  byTestId<HTMLButtonElement>(el, 'review-submit').click()
  await flush(el)
  return el
}

describe('AC-11: the review form follows the shopper’s session', () => {
  // Kills: no prompt (a guest gets a form whose every submit fails 401), or a prompt shown while auth is unknown.
  it('AC-11: the parts it renders follow auth: a profile load in flight renders the five form parts, the load settling signed out leaves only sign-in, a signed-in shopper gets the five form parts', async () => {
    const shown: Record<Auth, string[]> = { loading: [], 'signed-out': [], 'signed-in': [] }
    for (const auth of ['loading', 'signed-out', 'signed-in'] as const) {
      document.body.innerHTML = ''
      clientIn(auth)
      shown[auth] = renderedParts(await mounted())
    }

    expect(shown).toEqual({
      loading: FORM_PARTS,
      'signed-out': ['sign-in'],
      'signed-in': FORM_PARTS,
    })
  })

  it('AC-11: a load held while the element renders shows the form; once it settles signed out the form is gone and the sign-in link shows, and the profile was loaded once', async () => {
    const { release, loads } = clientIn('loading')
    const el = await mounted()
    const before = renderedParts(el)

    release()
    await flush(el)

    expect(before).toEqual(FORM_PARTS)
    expect(renderedParts(el)).toEqual(['sign-in'])
    expect(el.shadowRoot?.querySelector('[data-testid="review-form"]') ?? null).toBeNull()
    expect(loads()).toBe(1)
  })

  // Kills: a sign-in link that does not come back to the product (no redirect, or the path unencoded).
  it('AC-11: property: signed out on generated product paths, the sign-in link reads "Sign in to write a review" and its href is /account/login?redirect= the encoded location.pathname', async () => {
    await fc.assert(
      fc.asyncProperty(fc.stringMatching(/^[a-z0-9][a-z0-9 &=+-]{0,15}$/), async (slug) => {
        document.body.innerHTML = ''
        history.replaceState(null, '', `/product/${slug}`)
        clientIn('signed-out')
        const el = await mounted()

        const link = signInLink(el)

        expect(link?.getAttribute('href') ?? null, slug).toBe(
          `/account/login?redirect=${encodeURIComponent(location.pathname)}`,
        )
        expect(link?.getAttribute('part') ?? null).toBe('sign-in')
        expect((link?.textContent ?? '').trim()).toBe('Sign in to write a review')
      }),
      { numRuns: 15, examples: [['blue-mug']] },
    )
    history.replaceState(null, '', '/')
  })

  // Kills: the constant failure text (the refusal hidden behind "Something went wrong"), or every error's own message
  // shown (a network failure's "Failed to fetch").
  it('AC-11: property: a NymbalApiError refusal whose code starts reviews. or auth. (other than auth.unauthorized) shows the server’s message in the error part with the form still shown; a TypeError("Failed to fetch") or a NymbalApiError of another kind shows the generic text', async () => {
    const own = fc
      .tuple(
        fc.constantFrom(
          ['reviews.already_reviewed', 409] as const,
          ['reviews.submit_unsupported', 409] as const,
          ['auth.forbidden', 403] as const,
        ),
        fc.stringMatching(/^[A-Z][a-z]{3,12}( [a-z]{2,10}){1,5}\.$/),
      )
      .map(([[code, status], message]) => ({
        error: new NymbalApiError(code, message, status) as Error,
        shows: message,
      }))
    const other = fc.oneof(
      fc.constant({ error: new TypeError('Failed to fetch') as Error, shows: GENERIC }),
      fc
        .constantFrom(['internal', 500] as const, ['checkout.cart_empty', 409] as const)
        .map(([code, status]) => ({
          error: new NymbalApiError(code, `${code} happened`, status) as Error,
          shows: GENERIC,
        })),
    )
    await fc.assert(
      fc.asyncProperty(fc.oneof(own, other), async ({ error, shows }) => {
        document.body.innerHTML = ''
        const el = await refusedWith(error)

        expect(errorShown(el), error.message).toBe(shows)
        expect(renderedParts(el), error.message).toEqual([...FORM_PARTS, 'error'].sort())
      }),
      {
        numRuns: 20,
        examples: [
          [
            {
              error: new NymbalApiError(
                'reviews.already_reviewed',
                'You have already reviewed this product.',
                409,
              ),
              shows: 'You have already reviewed this product.',
            },
          ],
        ],
      },
    )
  })

  // Kills: an ended session left as a form whose every submit fails again.
  it('AC-11: a NymbalApiError auth.unauthorized 401 refusal turns the form into the sign-in link', async () => {
    const el = await refusedWith(
      new NymbalApiError('auth.unauthorized', 'Authentication required', 401),
    )

    expect(signInLink(el)?.getAttribute('part') ?? null).toBe('sign-in')
    expect(renderedParts(el).filter((p) => FORM_PARTS.includes(p))).toEqual([])
  })
})
