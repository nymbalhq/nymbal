/**
 * What a handler resolves when it has sent the browser elsewhere (`location.href = …`): the form stays locked until the
 * browser restores the page from its back/forward cache.
 */
export type SubmitOutcome = void | 'leaving'

export type SubmitHandler = (event: SubmitEvent) => Promise<SubmitOutcome> | SubmitOutcome

function submitButtonOf(event: SubmitEvent, form: HTMLFormElement): HTMLButtonElement | null {
  if (event.submitter instanceof HTMLButtonElement) return event.submitter
  return form.querySelector<HTMLButtonElement>('button[type="submit"], button:not([type])')
}

/**
 * Runs `handler` for a submit of `form`, ignoring every further submit until it settles. The flag, not the button, is
 * the guard: `requestSubmit()` and Enter in a field still fire `submit` while the button is disabled.
 */
export function submitOnce(form: HTMLFormElement | null, handler: SubmitHandler): void {
  if (form === null) return
  let inFlight = false
  /** Releases the lock a `'leaving'` resolve left; null while no such lock is held. */
  let releaseLeaving: (() => void) | null = null

  // Back to a page the browser kept in its back/forward cache: the navigation that locked the form left that page.
  window.addEventListener('pageshow', (event) => {
    if ((event as PageTransitionEvent).persisted !== true || releaseLeaving === null) return
    releaseLeaving()
    releaseLeaving = null
  })

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    if (inFlight) return
    inFlight = true
    const button = submitButtonOf(event as SubmitEvent, form)
    if (button) button.disabled = true

    const release = () => {
      inFlight = false
      if (button) button.disabled = false
    }

    // Inside `then`, a synchronous throw from the handler becomes a rejection and releases the form like one.
    Promise.resolve()
      .then(() => handler(event as SubmitEvent))
      .then(
        (outcome) => {
          if (outcome === 'leaving') releaseLeaving = release
          else release()
        },
        (reason: unknown) => {
          release()
          console.error('A form submit handler failed', reason)
        },
      )
  })
}
