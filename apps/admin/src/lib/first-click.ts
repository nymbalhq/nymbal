import type { MouseEvent } from 'react'

/**
 * A click handler that acts on a single click only: the second click of a double-click whose first opened or closed a
 * dialog lands on whatever is under the pointer now, and must not act there. A submit button's second click submits
 * nothing. Enter and Space click with detail 0.
 */
export function firstClick(
  action: () => void = () => {},
): (e: MouseEvent<HTMLButtonElement>) => void {
  return (e) => {
    if (e.detail > 1) {
      e.preventDefault()
      return
    }
    action()
  }
}
