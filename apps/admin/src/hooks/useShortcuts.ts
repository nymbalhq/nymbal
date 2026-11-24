import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { SEQUENCE_TIMEOUT_MS, isTypingTarget, readKey, type ShortcutCommand } from '@/lib/shortcuts'

const OPEN_LAYER = '[role=dialog], [role=alertdialog], [role=menu], [role=listbox]'
const SEARCH_FIELD = '[data-search-field]'

/** Focuses the row link after (or before) the row holding focus, or the first row's when focus is in no row. */
function moveRow(step: 1 | -1): boolean {
  const links = Array.from(document.querySelectorAll<HTMLElement>('main [data-row-link]'))
  if (links.length === 0) return false
  const row = document.activeElement?.closest('[data-row-id]') ?? null
  const at = row === null ? -1 : links.findIndex((l) => l.closest('[data-row-id]') === row)
  const next = at === -1 ? links[0] : links[at + step]
  if (next === undefined) return false
  next.focus()
  return true
}

function toggleFocusedRow(): boolean {
  const row = document.activeElement?.closest('main [data-row-id]')
  const box = row?.querySelector<HTMLElement>('[data-row-select]')
  if (!box) return false
  box.click()
  return true
}

/** The admin's single-key shortcuts, read from one listener on `window`; returns the help dialog's state. */
export function useShortcuts() {
  const navigate = useNavigate()
  const [helpOpen, setHelpState] = useState(false)
  const helpShown = useRef(false)
  const setHelpOpen = useCallback((open: boolean) => {
    helpShown.current = open
    setHelpState(open)
  }, [])
  const pending = useRef<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    const run = (command: ShortcutCommand): boolean => {
      switch (command.type) {
        case 'go':
          navigate(command.to)
          return true
        case 'help':
          setHelpOpen(true)
          return true
        case 'focus-search': {
          const field = document.querySelector<HTMLElement>(`main ${SEARCH_FIELD}`)
          if (!field) return false
          field.focus()
          return true
        }
        case 'next':
          return moveRow(1)
        case 'prev':
          return moveRow(-1)
        case 'toggle-select':
          return toggleFocusedRow()
      }
    }

    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target
      const plain =
        !event.ctrlKey &&
        !event.metaKey &&
        !event.altKey &&
        !event.isComposing &&
        event.keyCode !== 229
      if (
        event.key === 'Escape' &&
        plain &&
        target instanceof HTMLElement &&
        target.matches(SEARCH_FIELD)
      ) {
        target.blur()
        return
      }
      // Radix counts the help as the top layer only a render after it shows, and drops an Escape that comes sooner.
      if (event.key === 'Escape' && helpShown.current && !event.defaultPrevented) {
        event.preventDefault()
        setHelpOpen(false)
        return
      }
      if (isTypingTarget(target) || document.querySelector(OPEN_LAYER) !== null) return

      const read = readKey(pending.current, event)
      pending.current = read.pending
      clearTimeout(timer.current)
      if (read.pending !== null) {
        timer.current = setTimeout(() => {
          pending.current = null
        }, SEQUENCE_TIMEOUT_MS)
      }
      if (read.command !== null && run(read.command)) event.preventDefault()
    }

    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      clearTimeout(timer.current)
    }
  }, [navigate, setHelpOpen])

  return { helpOpen, setHelpOpen }
}
