import fc from 'fast-check'
import { afterEach, describe, expect, it } from 'vitest'
import { isTypingTarget, readKey, type KeyInput, type ShortcutCommand } from './shortcuts'

// The key reader is judged against this file's own copy of the key map, not the module's table, so a table that
// drifts from the map fails here; the typing-field test is judged on elements built the way the admin renders them.

/** The key map: `g` then a letter goes to a page; five single keys. */
const GO: Record<string, string> = {
  d: '/',
  o: '/orders',
  p: '/products',
  i: '/inventory',
  c: '/customers',
  a: '/activity',
  n: '/inbox',
  s: '/settings',
}
const SINGLE: Record<string, ShortcutCommand> = {
  '?': { type: 'help' },
  '/': { type: 'focus-search' },
  j: { type: 'next' },
  k: { type: 'prev' },
  x: { type: 'toggle-select' },
}

const LETTERS = 'abcdefghijklmnopqrstuvwxyz'
const KEYS = [
  ...LETTERS,
  ...LETTERS.toUpperCase(),
  ...'0123456789',
  ...'/?.,;:\'"[]{}-=_+!@#$%^&*()`~\\| ',
  'Enter',
  'Escape',
  'Tab',
]

const IME_KEYCODE = 229

/** On about one time in `n`. */
const sometimes = (n: number) => fc.noBias(fc.integer({ min: 1, max: n })).map((v) => v === 1)

/** A key as the browser reports it: each modifier and composition on about one time in five, Safari's IME code one in
 * ten, so most keys are plain and sequences reach the commands. */
const keyInput: fc.Arbitrary<KeyInput> = fc
  .record({
    key: fc.constantFrom(...KEYS),
    ctrlKey: sometimes(5),
    metaKey: sometimes(5),
    altKey: sometimes(5),
    isComposing: sometimes(5),
    ime: sometimes(10),
  })
  .map(({ ime, ...k }) => ({
    ...k,
    keyCode: ime ? IME_KEYCODE : k.key.length === 1 ? k.key.toUpperCase().charCodeAt(0) : 13,
  }))

const blocked = (k: KeyInput) =>
  k.ctrlKey || k.metaKey || k.altKey || k.isComposing || k.keyCode === IME_KEYCODE

const plainKey = (key: string): KeyInput => ({
  key,
  keyCode: key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  isComposing: false,
})

/** The map read one key at a time: what the merchant should get from the sequence. */
function oracle(keys: readonly KeyInput[]): {
  commands: ShortcutCommand[]
  pending: string | null
} {
  const commands: ShortcutCommand[] = []
  let pending: string | null = null
  for (const k of keys) {
    if (blocked(k)) {
      pending = null
      continue
    }
    if (pending === 'g') {
      const to = GO[k.key]
      if (to !== undefined) commands.push({ type: 'go', to })
      pending = null
      continue
    }
    if (k.key === 'g') {
      pending = 'g'
      continue
    }
    const single = SINGLE[k.key]
    if (single !== undefined) commands.push(single)
  }
  return { commands, pending }
}

function fold(keys: readonly KeyInput[]): { commands: ShortcutCommand[]; pending: string | null } {
  const commands: ShortcutCommand[] = []
  let pending: string | null = null
  for (const k of keys) {
    const read: { command: ShortcutCommand | null; pending: string | null } = readKey(pending, k)
    if (read.command !== null) commands.push(read.command)
    pending = read.pending
  }
  return { commands, pending }
}

/** Sequences that mix the map's keys in often enough to exercise every command. */
const sequence = fc.array(
  fc.oneof(
    { weight: 3, arbitrary: keyInput },
    {
      weight: 2,
      arbitrary: fc.constantFrom('g', ...Object.keys(GO), ...Object.keys(SINGLE)).map(plainKey),
    },
  ),
  { maxLength: 40 },
)

describe('readKey', () => {
  // Kills: Ctrl-K, Cmd-C or an IME keystroke read as a shortcut; `g x` selecting a row; a binding missing, moved or
  // pointing at another page.
  it('AC-1: folded over any key sequence it yields exactly the key map’s commands, in order', () => {
    fc.assert(
      fc.property(sequence, (keys) => {
        expect(fold(keys)).toEqual(oracle(keys))
      }),
      { numRuns: 500 },
    )
  })

  it('AC-1: a key with Ctrl, Meta or Alt held, composing, or with keyCode 229 yields nothing and clears the prefix', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<string | null>(null, 'g'),
        fc
          .record({
            key: fc.constantFrom(...KEYS),
            blocker: fc.constantFrom('ctrlKey', 'metaKey', 'altKey', 'isComposing', 'ime'),
          })
          .map(({ key, blocker }): KeyInput => {
            const k = plainKey(key)
            return blocker === 'ime' ? { ...k, keyCode: IME_KEYCODE } : { ...k, [blocker]: true }
          }),
        (pending, key) => {
          expect(readKey(pending, key)).toEqual({ command: null, pending: null })
        },
      ),
      { numRuns: 300 },
    )
  })

  it('AC-1: after g, a key that is not a page letter yields nothing and is not read as a command of its own', () => {
    const unmapped = KEYS.filter((k) => GO[k] === undefined)
    fc.assert(
      fc.property(fc.constantFrom(...unmapped), (key) => {
        expect(readKey('g', plainKey(key))).toEqual({ command: null, pending: null })
      }),
    )
    for (const key of Object.keys(SINGLE)) {
      expect(readKey('g', plainKey(key)), `g then ${key}`).toEqual({ command: null, pending: null })
      expect(readKey(null, plainKey(key)).command, `${key} alone`).toEqual(SINGLE[key])
    }
  })
})

// ---------------------------------------------------------------------------------------------------------------

type Build = { describe: string; make: () => { root: Element; target: EventTarget } }

const el = (tag: string, attrs: Record<string, string> = {}): HTMLElement => {
  const e = document.createElement(tag)
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v)
  return e
}

const alone = (describe: string, make: () => HTMLElement): Build => ({
  describe,
  make: () => {
    const e = make()
    return { root: e, target: e }
  },
})

const TEXT_INPUT_TYPES = ['', 'text', 'search', 'email', 'url', 'tel', 'password', 'number', 'date']
const NOT_TEXT_INPUT_TYPES = [
  'checkbox',
  'radio',
  'button',
  'submit',
  'reset',
  'file',
  'range',
  'color',
]

const typingHosts: Build[] = [
  ...TEXT_INPUT_TYPES.map((type) =>
    alone(`input type="${type}"`, () => el('input', type === '' ? {} : { type })),
  ),
  alone('textarea', () => el('textarea')),
  alone('select', () => {
    const s = el('select')
    s.append(el('option'))
    return s
  }),
  alone('contenteditable="true"', () => el('div', { contenteditable: 'true' })),
  alone('contenteditable=""', () => el('div', { contenteditable: '' })),
  alone('input role=combobox', () => el('input', { type: 'text', role: 'combobox' })),
  alone('input role=searchbox', () => el('input', { type: 'search', role: 'searchbox' })),
  alone('contenteditable role=textbox', () =>
    el('div', { role: 'textbox', contenteditable: 'true' }),
  ),
  alone('contenteditable role=searchbox', () =>
    el('div', { role: 'searchbox', contenteditable: 'true' }),
  ),
]

/** An element `depth` levels inside a host that holds children (a contenteditable, or a select's option). */
const insideTyping = fc
  .record({
    host: fc.constantFrom('contenteditable', 'textbox', 'select'),
    depth: fc.integer({ min: 1, max: 3 }),
  })
  .map(
    ({ host, depth }): Build => ({
      describe: `${depth} deep inside ${host}`,
      make: () => {
        if (host === 'select') {
          const s = el('select')
          const o = el('option')
          s.append(o)
          return { root: s, target: o }
        }
        const root =
          host === 'textbox'
            ? el('div', { role: 'textbox', contenteditable: 'true' })
            : el('div', { contenteditable: 'true' })
        let at: HTMLElement = root
        for (let i = 0; i < depth; i += 1) {
          const child = el(i % 2 === 0 ? 'span' : 'b')
          at.append(child)
          at = child
        }
        return { root, target: at }
      },
    }),
  )

const notTyping: Build[] = [
  ...NOT_TEXT_INPUT_TYPES.map((type) => alone(`input type="${type}"`, () => el('input', { type }))),
  alone('button', () => el('button')),
  alone('Select trigger: button role=combobox', () =>
    el('button', { type: 'button', role: 'combobox', 'aria-expanded': 'false' }),
  ),
  alone('Radix checkbox: button role=checkbox', () =>
    el('button', { type: 'button', role: 'checkbox', 'aria-checked': 'false' }),
  ),
  alone('link', () => el('a', { href: '/orders/NYM-1001' })),
  {
    describe: 'table row',
    make: () => {
      const table = el('table')
      const body = el('tbody')
      const row = el('tr', { 'data-row-id': 'o-1' })
      row.append(el('td'))
      body.append(row)
      table.append(body)
      return { root: table, target: row }
    },
  },
  {
    describe: 'span inside a button',
    make: () => {
      const b = el('button')
      const s = el('span')
      b.append(s)
      return { root: b, target: s }
    },
  },
]

const mounted: Element[] = []
afterEach(() => {
  for (const e of mounted.splice(0)) e.remove()
})

function judge(build: Build): boolean {
  const { root, target } = build.make()
  document.body.append(root)
  mounted.push(root)
  return isTypingTarget(target)
}

describe('isTypingTarget', () => {
  // Kills: `j` typed into the orders search moving a row (a field read as not typing).
  it('AC-2: true for every text-like field and for any element inside one', () => {
    fc.assert(
      fc.property(fc.oneof(fc.constantFrom(...typingHosts), insideTyping), (build) => {
        expect(judge(build), build.describe).toBe(true)
      }),
      { numRuns: 200 },
    )
  })

  // Kills: `x` on a focused checkbox swallowed as typing; after picking a payment filter (focus back on the Select
  // trigger) every shortcut dead.
  it('AC-2: false for a checkbox, radio, button, Select trigger, link, table row and the page body', () => {
    fc.assert(
      fc.property(fc.constantFrom(...notTyping), (build) => {
        expect(judge(build), build.describe).toBe(false)
      }),
      { numRuns: 100 },
    )
    expect(isTypingTarget(document.body), 'document.body').toBe(false)
    expect(isTypingTarget(null), 'no target').toBe(false)
    // The two sets judged apart: every typing host is true and every other element false.
    const verdicts = [...typingHosts, ...notTyping].map(judge)
    expect(verdicts.filter(Boolean).length).toBe(typingHosts.length)
  })
})
