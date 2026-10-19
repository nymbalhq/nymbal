// @vitest-environment jsdom
import fc from 'fast-check'
import { afterEach, describe, expect, it } from 'vitest'
import { submitOnce } from '../src/lib/submit-once'

// P1-15 AC-1: `submitOnce(form, handler)` (decision 1). For any number and kind of extra submits while one call is in
// flight, the handler runs once and the submit button is disabled. A rejection, a synchronous throw or a resolve without
// 'leaving' unlocks the form: the next submit runs the handler again and the button is enabled. A resolve of 'leaving'
// keeps it locked. Kills: a second submit running the handler (a guard that trusts the disabled button, since
// `requestSubmit()` still fires `submit` while it is disabled), a throw or rejection that leaves the form locked, and a
// leaving form that unlocks.

type Extra = 'click' | 'requestSubmit' | 'requestSubmitWithButton'
type Settle = 'resolve' | 'reject' | 'throw' | 'leaving'

interface Deferred {
  promise: Promise<void | 'leaving'>
  resolve(value: void | 'leaving'): void
  reject(reason: unknown): void
}

function deferred(): Deferred {
  let resolve!: Deferred['resolve']
  let reject!: Deferred['reject']
  const promise = new Promise<void | 'leaving'>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function mountForm() {
  document.body.innerHTML = `
    <form id="guarded-form">
      <input name="note" value="hello" />
      <button type="submit" data-testid="guarded-submit">Save</button>
    </form>
  `
  const form = document.getElementById('guarded-form') as HTMLFormElement
  const button = form.querySelector('button') as HTMLButtonElement
  return { form, button }
}

function fire(kind: Extra, form: HTMLFormElement, button: HTMLButtonElement) {
  if (kind === 'click') button.click()
  else if (kind === 'requestSubmit') form.requestSubmit()
  else form.requestSubmit(button)
}

/** Every pending promise reaction runs before a macrotask does. */
const drainMicrotasks = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

const extraArb = fc.constantFrom<Extra>('click', 'requestSubmit', 'requestSubmitWithButton')
const settleArb = fc.constantFrom<Settle>('resolve', 'reject', 'throw', 'leaving')

afterEach(() => {
  document.body.innerHTML = ''
})

describe('AC-1: submitOnce runs one handler call at a time and unlocks unless the handler leaves', () => {
  it('AC-1: any extra submits while in flight are ignored; the settle kind decides whether the next submit runs', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(extraArb, { minLength: 1, maxLength: 8 }),
        fc.array(extraArb, { minLength: 0, maxLength: 4 }),
        settleArb,
        extraArb,
        async (syncExtras, laterExtras, settle, next) => {
          const { form, button } = mountForm()
          const first = deferred()
          let calls = 0
          let disabledWhenRun: boolean | undefined
          submitOnce(form, () => {
            calls += 1
            if (calls > 1) return
            disabledWhenRun = button.disabled
            if (settle === 'throw') throw new Error('handler threw synchronously')
            return first.promise
          })

          // The first submit, then extras in the same task (before the handler has started) and, unless the handler
          // throws (it settles within microtasks), once it has started.
          button.click()
          for (const kind of syncExtras) fire(kind, form, button)
          if (settle !== 'throw') {
            await Promise.resolve()
            for (const kind of laterExtras) fire(kind, form, button)
          }

          // A throwing handler has settled before this read could see it in flight.
          const disabledLaterInFlight = settle === 'throw' || button.disabled

          if (settle === 'resolve') first.resolve(undefined)
          if (settle === 'reject') first.reject(new Error('handler rejected'))
          if (settle === 'leaving') first.resolve('leaving')
          await drainMicrotasks()

          const disabledAfterSettle = button.disabled
          const callsBeforeNext = calls
          // A leaving form must ignore a submit its disabled button cannot make, so `requestSubmit()` too.
          fire(next, form, button)
          if (settle === 'leaving') form.requestSubmit()
          await drainMicrotasks()
          const ranAgain = calls - callsBeforeNext

          const leaves = settle === 'leaving'
          // Every extra, made before or after the handler started, was ignored.
          expect(callsBeforeNext).toBe(1)
          expect(disabledWhenRun).toBe(true)
          expect(disabledLaterInFlight).toBe(true)
          expect(disabledAfterSettle).toBe(leaves)
          expect(ranAgain).toBe(leaves ? 0 : 1)
        },
      ),
      { numRuns: 120 },
    )
  })
})
