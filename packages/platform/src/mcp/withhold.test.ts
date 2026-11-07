import { readFileSync } from 'node:fs'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { CustomerField } from '@nymbalhq/config'
import type { ToolResult } from '@nymbalhq/types'
import { createTurnMask } from '../assistant/mask.js'
import { kindOfKey } from '../customer-fields.js'
import { withholdResult } from './withhold.js'

// What an admin's MCP client receives of a tool result: the customer fields a store withholds are removed by key (the
// assistant mask's key rule, shared), a history change's values are removed by the field its path names, a removed
// value repeated in other text is replaced, and emails and phones typed into free text are replaced. The result says
// which kinds it lost in `withheld`.
// - AC-1: property, the result is the input less exactly those values, its text block is its JSON, and `withheld`
//   names exactly the kinds taken.
// - AC-2: free text, by example and as a property against the mask's own patterns.
// - AC-3: property, the withholder removes and replaces exactly where the mask masks; one key rule, one place.

const FIELDS = [
  'email',
  'phone',
  'address',
  'postcode',
  'name',
] as const satisfies readonly CustomerField[]
type Field = (typeof FIELDS)[number]
const DEFAULT: Field[] = ['email', 'phone', 'address', 'postcode']

// ─── The model: what a generated value leaves behind ────────────────────────────────────────────────────────────────

/** What withholding leaves of one generated value under the listed fields, the kinds it took and the values removed. */
type Left =
  | { kept: false; kinds: Field[]; removed: string[] }
  | { kept: true; value: unknown; kinds: Field[]; removed: string[] }

interface Gen {
  input: unknown
  left(listed: ReadonlySet<Field>): Left
}

const kept = (value: unknown, kinds: Field[] = [], removed: string[] = []): Left => ({
  kept: true,
  value,
  kinds,
  removed,
})

/** A string under `key` that repeats no other value: gone when its key's kind is listed and it is not empty. */
function keyed(key: string, text: string): Gen {
  return {
    input: text,
    left: (listed) => {
      const kind = kindOfKey(key) as Field | undefined
      return kind !== undefined && listed.has(kind) && text !== ''
        ? { kept: false, kinds: [kind], removed: [text] }
        : kept(text)
    },
  }
}

/** A value that is not a string and holds none (a number, a boolean, null): kept as it is, under any key. */
const scalar = (value: unknown): Gen => ({ input: value, left: () => kept(value) })

/**
 * A string made of plain text and values, each value replaced by `[<kind> withheld]` exactly when its kind is listed:
 * an email or a phone in free text, or a value the same result removes by key (each such value here is one the
 * generator also places under a key of its kind, never empty, so it is removed exactly when its kind is listed).
 */
function prose(parts: Array<string | [value: string, kind: Field]>): Gen {
  return {
    input: parts.map((part) => (typeof part === 'string' ? part : part[0])).join(''),
    left: (listed) => {
      const kinds: Field[] = []
      const text = parts
        .map((part) => {
          if (typeof part === 'string') return part
          const [value, kind] = part
          if (!listed.has(kind) || value.length < 3) return value
          kinds.push(kind)
          return `[${kind} withheld]`
        })
        .join('')
      return kept(text, kinds)
    },
  }
}

function object(entries: Array<[string, Gen]>): Gen {
  return {
    input: Object.fromEntries(entries.map(([key, gen]) => [key, gen.input])),
    left: (listed) => {
      const value: Record<string, unknown> = {}
      const kinds: Field[] = []
      const removed: string[] = []
      for (const [key, gen] of entries) {
        const left = gen.left(listed)
        kinds.push(...left.kinds)
        removed.push(...left.removed)
        if (left.kept) value[key] = left.value
      }
      return kept(value, kinds, removed)
    },
  }
}

function array(items: Gen[]): Gen {
  return {
    input: items.map((item) => item.input),
    left: (listed) => {
      const value: unknown[] = []
      const kinds: Field[] = []
      const removed: string[] = []
      for (const item of items) {
        const left = item.left(listed)
        kinds.push(...left.kinds)
        removed.push(...left.removed)
        if (left.kept) value.push(left.value)
      }
      return kept(value, kinds, removed)
    },
  }
}

/** A history change of the field `path` ends in: its from and to go when that field's kind is listed. */
function change(path: string, from: string, to: string): Gen {
  return {
    input: { path, from, to },
    left: (listed) => {
      const kind = kindOfKey(path.split('.').at(-1)!) as Field | undefined
      return kind !== undefined && listed.has(kind)
        ? kept({ path }, [kind], [from, to])
        : kept({ path, from, to })
    },
  }
}

// ─── Generated admin results ────────────────────────────────────────────────────────────────────────────────────────

// Each value of a kind carries its kind's mark, so no value of one kind is ever text of another, no value stands whole
// inside another of its kind, and plain text never holds one.
const n = fc.nat({ max: 99_999 })
const anEmail = n.map((i) => `c${i}x@example.com`)
const aPhone = n.map((i) => `07700 9${String(i).padStart(5, '0')}`)
const aStreet = n.map((i) => `Flat ${i} Marker Lane`)
const aPostcode = n.map((i) => `PC${i} 9ZZ`)
const aName = fc.stringMatching(/^[a-z]{1,6}$/).map((s) => `Nm${s}`)
const aWord = fc.constantFrom(
  'London',
  'Leeds',
  'England',
  'GB',
  'Acme Ltd',
  'Blue Widget',
  'pending',
)
const anId = fc.uuid()
const anInstant = fc
  .integer({ min: 0, max: 4_000_000_000_000 })
  .map((ms) => new Date(ms).toISOString())

interface Shape {
  /** Text that wholly repeats a removed value (a city equal to its street line) may be generated. */
  wholeRepeats: boolean
  /** History pages may be generated. */
  history: boolean
}

function results(shape: Shape): fc.Arbitrary<Gen> {
  const address = fc
    .record({
      first: aName,
      last: aName,
      company: fc.option(aWord, { nil: undefined }),
      street: aStreet,
      line2: fc.constantFrom('absent', 'empty', 'street', 'null'),
      street2: aStreet,
      cityIsStreet: shape.wholeRepeats ? fc.boolean() : fc.constant(false),
      city: aWord,
      postcode: aPostcode,
      phone: fc.constantFrom('absent', 'empty', 'value', 'null'),
      phoneValue: aPhone,
    })
    .map((a) => {
      const entries: Array<[string, Gen]> = [
        ['firstName', keyed('firstName', a.first)],
        ['lastName', keyed('lastName', a.last)],
        ['addressLine1', keyed('addressLine1', a.street)],
        ['city', a.cityIsStreet ? prose([[a.street, 'address']]) : keyed('city', a.city)],
        ['region', keyed('region', 'England')],
        ['postalCode', keyed('postalCode', a.postcode)],
        ['country', keyed('country', 'GB')],
      ]
      if (a.company !== undefined) entries.push(['company', keyed('company', a.company)])
      if (a.line2 === 'empty') entries.push(['addressLine2', keyed('addressLine2', '')])
      if (a.line2 === 'street') entries.push(['addressLine2', keyed('addressLine2', a.street2)])
      if (a.line2 === 'null') entries.push(['addressLine2', scalar(null)])
      if (a.phone === 'empty') entries.push(['phone', keyed('phone', '')])
      if (a.phone === 'value') entries.push(['phone', keyed('phone', a.phoneValue)])
      if (a.phone === 'null') entries.push(['phone', scalar(null)])
      return { gen: object(entries), street: a.street, postcode: a.postcode }
    })

  const order = fc
    .record({
      id: anId,
      number: fc.nat({ max: 999_999 }),
      total: fc.nat(),
      email: anEmail,
      also: fc.option(fc.constantFrom('customerEmail', 'receiptEmail'), { nil: undefined }),
      alsoEmail: anEmail,
      billing: address,
      shipping: address,
      note: fc.constantFrom('plain', 'ring', 'leave'),
      plain: aWord,
      ringPhone: aPhone,
      ringEmail: anEmail,
      lines: fc.array(fc.record({ name: aWord, total: fc.nat() }), { maxLength: 2 }),
    })
    .map((o) => {
      const notes =
        o.note === 'ring'
          ? prose(['ring me on ', [o.ringPhone, 'phone'], ' or ', [o.ringEmail, 'email']])
          : o.note === 'leave'
            ? prose([
                'leave at ',
                [o.shipping.street, 'address'],
                ', ',
                [o.shipping.postcode, 'postcode'],
              ])
            : keyed('notes', o.plain)
      const entries: Array<[string, Gen]> = [
        ['id', keyed('id', o.id)],
        ['orderNumber', keyed('orderNumber', `NYM-${String(o.number).padStart(6, '0')}`)],
        ['totalMinor', scalar(o.total)],
        ['email', keyed('email', o.email)],
        ['billingAddress', o.billing.gen],
        ['shippingAddress', o.shipping.gen],
        ['notes', notes],
        [
          'lineItems',
          array(
            o.lines.map((line) =>
              object([
                ['name', keyed('name', line.name)],
                ['totalMinor', scalar(line.total)],
              ]),
            ),
          ),
        ],
      ]
      if (o.also !== undefined) entries.push([o.also, keyed(o.also, o.alsoEmail)])
      return object(entries)
    })

  const customer = fc
    .record({
      id: anId,
      email: anEmail,
      first: aName,
      last: aName,
      phoneAsList: fc.boolean(),
      phone: aPhone,
      phones: fc.array(fc.oneof(aPhone, fc.constant('')), { maxLength: 3 }),
      addresses: fc.array(address, { maxLength: 2 }),
      orders: fc.array(order, { maxLength: 2 }),
    })
    .map((c) =>
      object([
        ['id', keyed('id', c.id)],
        ['email', keyed('email', c.email)],
        ['firstName', keyed('firstName', c.first)],
        ['lastName', keyed('lastName', c.last)],
        [
          'phone',
          c.phoneAsList ? array(c.phones.map((p) => keyed('phone', p))) : keyed('phone', c.phone),
        ],
        ['addresses', array(c.addresses.map((a) => a.gen))],
        ['orders', object([['items', array(c.orders)]])],
      ]),
    )

  const orderList = fc.array(order, { maxLength: 3 }).map((items) =>
    object([
      ['items', array(items)],
      ['nextCursor', scalar(null)],
    ]),
  )

  // A capabilities-like answer: values under personal keys that are not strings are kept and walked.
  const capabilities = fc.tuple(fc.boolean(), n).map(([delivers, code]) =>
    object([
      ['email', object([['delivers', scalar(delivers)]])],
      ['phone', scalar(null)],
      ['postalCode', scalar(code)],
    ]),
  )

  const aChange = fc.oneof(
    fc.tuple(aPhone, aPhone).map(([from, to]) => change('phone', from, to)),
    fc.tuple(anEmail, anEmail).map(([from, to]) => change('email', from, to)),
    fc
      .tuple(anId, aPostcode, aPostcode)
      .map(([id, from, to]) => change(`addresses.${id}.postalCode`, from, to)),
    fc
      .tuple(anId, aStreet, aStreet)
      .map(([id, from, to]) => change(`addresses.${id}.addressLine1`, from, to)),
    anId.map((id) => change(`addresses.${id}.city`, 'London', 'Leeds')),
    // An address added whole: its path names no field, and the address under `to` is withheld by key.
    fc.tuple(anId, address).map(([id, a]) =>
      object([
        ['path', keyed('path', `addresses.${id}`)],
        ['from', scalar(null)],
        ['to', a.gen],
      ]),
    ),
  )
  const historyPage = fc
    .array(
      fc.record({ seq: fc.nat(), at: anInstant, changes: fc.array(aChange, { maxLength: 4 }) }),
      { maxLength: 3 },
    )
    .map((entries) =>
      object([
        [
          'entries',
          array(
            entries.map((e) =>
              object([
                ['seq', scalar(e.seq)],
                ['at', keyed('at', e.at)],
                ['changes', array(e.changes)],
              ]),
            ),
          ),
        ],
        ['nextCursor', scalar(null)],
      ]),
    )

  const page = shape.history
    ? fc.oneof(order, customer, orderList, capabilities, historyPage)
    : fc.oneof(order, customer, orderList, capabilities)

  // Any depth: the page as it is, or under one or two wrappers (an object key, or an array's one item).
  return fc
    .tuple(page, fc.array(fc.constantFrom('data', 'results'), { maxLength: 2 }))
    .map(([inner, wrappers]) =>
      wrappers.reduce<Gen>(
        (gen, wrapper) =>
          wrapper === 'data' ? object([['data', gen]]) : object([['results', array([gen])]]),
        inner,
      ),
    )
}

/** A tool result as the invoker builds one: the structured content and its JSON as the one text block. */
function resultOf(structured: Record<string, unknown>, isError = false): ToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(structured) }],
    structuredContent: structuredClone(structured),
    ...(isError && { isError: true }),
  }
}

/** Every string value in `value`, at any depth. */
function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(stringsIn)
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(stringsIn)
  return []
}

const fieldSets = fc.subarray([...FIELDS])

// ─── AC-1 ───────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('AC-1: a withheld result is the route’s answer less exactly the withheld values', () => {
  // Kills: a nested shippingAddress under items[] left whole, a history change keeping a phone in from or to, the text
  // block serialised before the strip, city, totalMinor or a non-string email capability dropped, and a withheld list
  // naming a kind nothing was taken for, or missing.
  it('AC-1: property: for any generated admin result and any set of the five fields, the structured content is the input with exactly the keyed values and history values of those kinds removed and their repeats and free-text emails and phones replaced, no string equals a removed value, the text block parses to it, and withheld lists exactly the kinds taken in the fields’ order, absent when none was', () => {
    fc.assert(
      fc.property(
        results({ wholeRepeats: true, history: true }),
        fieldSets,
        fc.boolean(),
        (gen, fields, isError) => {
          const out: ToolResult = withholdResult(
            resultOf(gen.input as Record<string, unknown>, isError),
            fields,
          )
          const left = gen.left(new Set(fields))
          const kinds = FIELDS.filter((field) => left.kinds.includes(field))
          const expected = {
            ...(left.kept ? (left.value as Record<string, unknown>) : {}),
            ...(kinds.length > 0 && { withheld: kinds }),
          }

          expect(out.structuredContent).toEqual(expected)
          expect(out.content.map((block) => block.type)).toEqual(['text'])
          expect(JSON.parse(out.content[0]!.text) as unknown).toEqual(out.structuredContent)
          expect(stringsIn(out.structuredContent).filter((s) => left.removed.includes(s))).toEqual(
            [],
          )
          expect(out.isError ?? false).toBe(isError)
        },
      ),
      { numRuns: 300 },
    )
  })

  it('AC-1: property: under no withheld fields the result is the input as it was, with no withheld key', () => {
    fc.assert(
      fc.property(results({ wholeRepeats: true, history: true }), fc.boolean(), (gen, isError) => {
        const result = resultOf(gen.input as Record<string, unknown>, isError)
        const before = structuredClone(result)

        expect(withholdResult(result, [])).toEqual(before)
      }),
    )
  })
})

// ─── AC-2 ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A mask token rewritten as the withholder's constant for its kind: `[phone-2]` becomes `[phone withheld]`. */
const asWithheld = (text: string): string =>
  text.replace(/\[(email|phone|address|postcode|name)-[1-9][0-9]*\]/g, '[$1 withheld]')

/** Free text that may hold emails, phones and their near misses; never a bracket, so never a token's shape. */
const FRAGMENTS = [
  'ring me on ',
  ' or ',
  ' ',
  '\n',
  ', ',
  '07700 900123',
  '+44 20 7946 0958',
  '(020) 7946 0958',
  '555-123-4567',
  '012345 678905',
  'ada@example.com',
  'x@2x.png',
  'NYM-07700900123',
  '07700900123',
  '019a2b3c-0770-0900-1234-56789abcdef0',
  '0',
  '7',
  '-',
  '.',
  '(',
  ')',
  '@',
  'a',
  'example.com',
] as const
const freeText = fc.oneof(
  fc.array(fc.constantFrom(...FRAGMENTS), { maxLength: 12 }).map((parts) => parts.join('')),
  // No whitespace at all: a phone is never looked for in such a string.
  fc
    .array(fc.constantFrom(...FRAGMENTS.filter((part) => !/\s/.test(part))), { maxLength: 6 })
    .map((parts) => parts.join('')),
  fc.string({ maxLength: 40 }).map((s) => s.replace(/[[\]]/g, '')),
)

describe('AC-2: emails and phones typed into text are replaced, and a withheld value repeated in text', () => {
  it('AC-2: an order note "ring me on 07700 900123 or ada@example.com" becomes "ring me on [phone withheld] or [email withheld]" with withheld email and phone', () => {
    const out = withholdResult(
      resultOf({
        orderNumber: 'NYM-000042',
        notes: 'ring me on 07700 900123 or ada@example.com',
      }),
      ['email', 'phone'],
    )

    expect(out.structuredContent).toEqual({
      orderNumber: 'NYM-000042',
      notes: 'ring me on [phone withheld] or [email withheld]',
      withheld: ['email', 'phone'],
    })
  })

  it('AC-2: an order whose street line 1 Protocol Street and postcode E1 6AN were withheld has its note "leave at 1 Protocol Street, E1 6AN" read "leave at [address withheld], [postcode withheld]"', () => {
    const out = withholdResult(
      resultOf({
        orderNumber: 'NYM-000043',
        shippingAddress: {
          addressLine1: '1 Protocol Street',
          city: 'London',
          postalCode: 'E1 6AN',
          country: 'GB',
        },
        notes: 'leave at 1 Protocol Street, E1 6AN',
      }),
      DEFAULT,
    )

    expect(out.structuredContent).toEqual({
      orderNumber: 'NYM-000043',
      shippingAddress: { city: 'London', country: 'GB' },
      notes: 'leave at [address withheld], [postcode withheld]',
      withheld: ['address', 'postcode'],
    })
  })

  it("AC-2: a proposal's args.reason holding an email has it replaced by [email withheld]", () => {
    const out = withholdResult(
      resultOf({
        id: '019a2b3c-0000-7000-8000-000000000001',
        tool: 'admin_orders_cancel',
        command: 'order.cancel',
        args: {
          id: '019a2b3c-0000-7000-8000-000000000002',
          reason: 'ada@example.com asked to cancel',
        },
        status: 'pending',
      }),
      DEFAULT,
    )

    expect(out.structuredContent).toEqual({
      id: '019a2b3c-0000-7000-8000-000000000001',
      tool: 'admin_orders_cancel',
      command: 'order.cancel',
      args: {
        id: '019a2b3c-0000-7000-8000-000000000002',
        reason: '[email withheld] asked to cancel',
      },
      status: 'pending',
      withheld: ['email'],
    })
  })

  it('AC-2: a phone-shaped run in a string without whitespace (an id, NYM-07700900123), a UUID’s digit groups in prose, 555-123-4567, and a street line or postcode in prose that no field holds are left as they are, and the result names nothing withheld', () => {
    const structured = {
      id: '019a2b3c-0770-0900-1234-56789abcdef0',
      orderNumber: 'NYM-07700900123',
      reference: '07700900123',
      notes: 'order 019a2b3c-0770-0900-1234-56789abcdef0 shipped; call 555-123-4567',
      delivery: 'deliver to 9 Elm Road, SW1A 1AA instead',
    }

    const out = withholdResult(resultOf(structured), [...FIELDS])

    expect(out.structuredContent).toEqual(structured)
  })

  // Kills: the withholder's patterns drifting from the mask's (a phone looked for without whitespace, a UUID's digit
  // groups read as a phone, an email's local part cut short).
  it('AC-2: property: for any string s and any fields, the spans the withholder replaces in { note: s } are exactly those the assistant’s mask replaces with email and phone tokens, and withheld names exactly their kinds', () => {
    fc.assert(
      fc.property(freeText, fieldSets, (note, fields) => {
        const masked = createTurnMask(fields).result({ note }).value['note'] as string
        const out = withholdResult(resultOf({ note }), fields)
        const kinds = FIELDS.filter((field) => masked.includes(`[${field}-`))

        expect(out.structuredContent).toEqual({
          note: asWithheld(masked),
          ...(kinds.length > 0 && { withheld: kinds }),
        })
      }),
      { numRuns: 500 },
    )
  })
})

// ─── AC-3 ───────────────────────────────────────────────────────────────────────────────────────────────────────────

const WHOLE_TOKEN = /^\[(email|phone|address|postcode|name)-[1-9][0-9]*\]$/

/** The mask's answer as the withholder should give it: a string the mask made one token whole is gone, and every other
 *  token is the withholder's constant for its kind. */
function maskAsWithheld(value: unknown): { kept: boolean; value: unknown } {
  if (typeof value === 'string') {
    return WHOLE_TOKEN.test(value)
      ? { kept: false, value }
      : { kept: true, value: asWithheld(value) }
  }
  if (Array.isArray(value)) {
    return {
      kept: true,
      value: value.map(maskAsWithheld).flatMap((item) => (item.kept ? [item.value] : [])),
    }
  }
  if (typeof value === 'object' && value !== null) {
    return {
      kept: true,
      value: Object.fromEntries(
        Object.entries(value).flatMap(([key, item]) => {
          const left = maskAsWithheld(item)
          return left.kept ? [[key, left.value]] : []
        }),
      ),
    }
  }
  return { kept: true, value }
}

const SOURCE = (path: string): string =>
  readFileSync(new URL(path, import.meta.url), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')

/** The key and free-text rules a source defines for itself. */
const RULES: Record<string, RegExp> = {
  kindOfKey: /\bfunction\s+kindOfKey\b|\b(?:const|let)\s+kindOfKey\s*=/,
  FREE_TEXT_EMAIL: /\bFREE_TEXT_EMAIL\s*=/,
  FREE_TEXT_PHONE: /\bFREE_TEXT_PHONE\s*=/,
  'an email key pattern': /\/email\$\/i?/,
  'a phone key pattern': /\/phone\$\/i?/,
  'a street key': /['"`]addressLine[12]['"`]/,
  'a postcode key': /['"`]postalCode['"`]/,
  'a name key': /['"`](?:firstName|lastName)['"`]/,
}
const rulesIn = (source: string): string[] =>
  Object.entries(RULES)
    .filter(([, rule]) => rule.test(source))
    .map(([name]) => name)

describe('AC-3: the withholder and the assistant’s mask are one rule', () => {
  // Kills: a key added to the mask's rule and not the withholder's, or the reverse; an empty string or an array item
  // under a personal key treated differently by the two; the second pass replacing different spans.
  it('AC-3: property: for any generated result and any non-empty set of fields, the withholder removes exactly the strings the mask replaces whole with one token by key, empty strings and array items under a personal key included, and replaces exactly the spans the mask’s second pass and free-text patterns replace', () => {
    fc.assert(
      fc.property(
        results({ wholeRepeats: false, history: false }),
        fc.subarray([...FIELDS], { minLength: 1 }),
        (gen, fields) => {
          const structured = gen.input as Record<string, unknown>
          const masked = createTurnMask(fields).result(structuredClone(structured)).value
          const out = withholdResult(resultOf(structured), fields).structuredContent ?? {}
          const { withheld: _withheld, ...rest } = out as Record<string, unknown>

          expect(rest).toEqual(maskAsWithheld(masked).value)
        },
      ),
      { numRuns: 300 },
    )
  })

  it('AC-3: kindOfKey and the free-text patterns are defined in customer-fields.ts alone; assistant/mask.ts and mcp/withhold.ts define no key or free-text rule and both import customer-fields', () => {
    const files = {
      'customer-fields.ts': SOURCE('../customer-fields.ts'),
      'assistant/mask.ts': SOURCE('../assistant/mask.ts'),
      'mcp/withhold.ts': SOURCE('./withhold.ts'),
    }
    const imports = /from\s+['"]\.\.\/customer-fields\.js['"]/

    expect(
      Object.fromEntries(Object.entries(files).map(([file, source]) => [file, rulesIn(source)])),
    ).toEqual({
      'customer-fields.ts': expect.arrayContaining([
        'kindOfKey',
        'FREE_TEXT_EMAIL',
        'FREE_TEXT_PHONE',
      ]),
      'assistant/mask.ts': [],
      'mcp/withhold.ts': [],
    })
    expect(
      Object.entries(files)
        .filter(([, source]) => imports.test(source))
        .map(([file]) => file),
    ).toEqual(['assistant/mask.ts', 'mcp/withhold.ts'])
  })
})

// ─── Cost ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A listed order as the admin API answers it: an email, two addresses with phones, two lines and a note. */
function listedOrder(n: number): Record<string, unknown> {
  const id = String(n).padStart(6, '0')
  const address = (street: string) => ({
    firstName: `Ada${id}`,
    lastName: 'Lovelace',
    addressLine1: `${n} ${street}`,
    addressLine2: `Flat ${id}`,
    city: 'London',
    postalCode: `E${n} 6AN`,
    country: 'GB',
    phone: `07700 9${String(n).padStart(5, '0')}`,
  })
  return {
    id: `019a2b3c-0000-7000-8000-${String(n).padStart(12, '0')}`,
    orderNumber: `NYM-${id}`,
    email: `customer${id}@example.com`,
    status: 'paid',
    shippingAddress: address('Protocol Street'),
    billingAddress: address('Engine Row'),
    items: [
      { sku: `SKU-${id}-A`, title: 'Analytical notebook', quantity: 1, unitPrice: 1200 },
      { sku: `SKU-${id}-B`, title: 'Difference pen', quantity: 2, unitPrice: 450 },
    ],
    notes: `leave at ${n} Protocol Street, E${n} 6AN`,
  }
}

describe('the cost of withholding a page of orders', () => {
  // Kills: one pass per withheld value over every string, which grows with the square of the page and blocks the
  // event loop for seconds on the admin list route's 200 orders.
  it('a page of 200 orders, each with an email, two addresses with phones and a note repeating its street and postcode, is withheld in under 250 ms (not one pass per withheld value over every string), every note replaced', () => {
    const items = Array.from({ length: 200 }, (_, i) => listedOrder(i + 1))
    withholdResult(resultOf({ items: items.slice(0, 5) }), DEFAULT)

    const started = performance.now()
    const out = withholdResult(resultOf({ items }), DEFAULT)
    const elapsed = performance.now() - started

    const left = (out.structuredContent?.['items'] ?? []) as Array<Record<string, unknown>>
    expect(left.map((order) => order['notes'])).toEqual(
      items.map(() => 'leave at [address withheld], [postcode withheld]'),
    )
    expect(elapsed).toBeLessThan(250)
  })
})
