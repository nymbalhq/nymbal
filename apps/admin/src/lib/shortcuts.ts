import { NAVIGATION_COMMANDS } from '@/lib/palette-commands'

export type ShortcutCommand =
  | { type: 'go'; to: string }
  | { type: 'help' }
  | { type: 'focus-search' }
  | { type: 'next' }
  | { type: 'prev' }
  | { type: 'toggle-select' }

export interface KeyInput {
  key: string
  keyCode: number
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  isComposing: boolean
}

/** An entry with no command is shown in the help only. */
export interface Shortcut {
  keys: readonly string[]
  label: string
  command?: ShortcutCommand
}

export const SEQUENCE_TIMEOUT_MS = 1500

const GO_PREFIX = 'g'

/** Safari reports a keystroke the IME is handling with this code and no `isComposing`. */
const IME_KEYCODE = 229

// The palette's pages are the go-to targets, so the two cannot point at different places.
const GO_LETTERS: Record<string, string> = {
  'go-dashboard': 'd',
  'go-orders': 'o',
  'go-products': 'p',
  'go-inventory': 'i',
  'go-customers': 'c',
  'go-reports': 'r',
  'go-activity': 'a',
  'go-inbox': 'n',
  'go-settings': 's',
}

const GO_SHORTCUTS: Shortcut[] = NAVIGATION_COMMANDS.flatMap((c) => {
  const letter = GO_LETTERS[c.id]
  return letter === undefined
    ? []
    : [{ keys: [GO_PREFIX, letter], label: c.label, command: { type: 'go', to: c.to } }]
})

export const SHORTCUTS: readonly Shortcut[] = [
  ...GO_SHORTCUTS,
  { keys: ['/'], label: 'Search this page', command: { type: 'focus-search' } },
  { keys: ['Esc'], label: 'Leave the search field' },
  { keys: ['j'], label: 'Next row', command: { type: 'next' } },
  { keys: ['k'], label: 'Previous row', command: { type: 'prev' } },
  { keys: ['x'], label: 'Select the order', command: { type: 'toggle-select' } },
  { keys: ['⌘/Ctrl', 'K'], label: 'Open the command palette' },
  { keys: ['?'], label: 'Show keyboard shortcuts', command: { type: 'help' } },
]

const NONE = { command: null, pending: null } as const

/** One key against the pending prefix ('g' or null): the command it completes, if any, and the new prefix. */
export function readKey(
  pending: string | null,
  key: KeyInput,
): { command: ShortcutCommand | null; pending: string | null } {
  if (key.ctrlKey || key.metaKey || key.altKey || key.isComposing || key.keyCode === IME_KEYCODE) {
    return NONE
  }
  if (pending === null && key.key === GO_PREFIX) return { command: null, pending: GO_PREFIX }
  const sequence = pending === null ? [key.key] : [pending, key.key]
  const match = SHORTCUTS.find(
    (s) =>
      s.command !== undefined &&
      s.keys.length === sequence.length &&
      s.keys.every((k, i) => k === sequence[i]),
  )
  return { command: match?.command ?? null, pending: null }
}

const NOT_TYPED_INPUT_TYPES = new Set([
  'checkbox',
  'radio',
  'button',
  'submit',
  'reset',
  'file',
  'range',
  'color',
])

/** A field the merchant types into, or an element inside one. Reads attributes, not `isContentEditable`, which jsdom
 * does not implement. A role alone (a `div[role=textbox]`, a `button[role=combobox]`) does not make a typing field. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false
  if (target instanceof HTMLInputElement) return !NOT_TYPED_INPUT_TYPES.has(target.type)
  if (target.closest('textarea, select') !== null) return true
  const editable = target.closest('[contenteditable]')
  if (editable === null) return false
  const value = editable.getAttribute('contenteditable')
  return value === '' || value === 'true' || value === 'plaintext-only'
}
