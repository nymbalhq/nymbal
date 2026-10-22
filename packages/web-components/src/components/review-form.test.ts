import fc from 'fast-check'
import { describe, expect, it, vi } from 'vitest'
import { setupMockClient } from '../testing/index.js'

// P2-17 AC-5 (spec Decision 1, the mandatory double-submit criterion): `nymbal-review-form` submits once per click
// through `client.adapter.reviews.submit`. The shopper fills the form and clicks submit, then the form is submitted
// k - 1 more times (`requestSubmit()`, which fires `submit` even while the button is disabled) while the first call is
// held. Exactly one call is made, with `{ productId, rating, title, body }`; `submit` is disabled while it is held; on
// success one `nymbal:review:submitted` fires with the review's id, the form resets and `submit` re-enables; on a
// refusal the `error` part shows, `submit` re-enables and nothing fires. This replaces the review case of
// templates/astro/tests/forms-submit-once.test.ts, whose script (`scripts/review-form.ts`) goes. Kills: a handler not
// guarded while in flight (k clicks make k reviews), a refusal leaving the form stuck, success firing twice or not at
// all, a form that keeps the text it sent.

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

describe('P2-17 AC-5: the review form submits once per click', () => {
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
