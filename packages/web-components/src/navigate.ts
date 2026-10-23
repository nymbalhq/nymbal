/**
 * The click handler of an element's anchor part. An anchor in a shadow root is a plain `<a>`, which a client-side
 * router does not see, so a plain left click asks the page first: a cancelable, composed `nymbal:navigate` with the
 * href. A page that routes it (Next's `router.push`) cancels the event, and the click's own navigation is prevented; a
 * page that does not leaves the anchor to load the page. A click with a modifier key or another button is the
 * browser's (a new tab or window), untouched.
 */
export function navigateOnClick(event: MouseEvent): void {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  ) {
    return
  }
  const anchor = event.currentTarget as HTMLAnchorElement | null
  const href = anchor?.getAttribute('href')
  if (anchor === null || href === null || href === undefined) return
  const routed = !anchor.dispatchEvent(
    new CustomEvent('nymbal:navigate', {
      detail: { href },
      bubbles: true,
      composed: true,
      cancelable: true,
    }),
  )
  if (routed) event.preventDefault()
}
