import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { createTurnMask, type MaskField } from './mask.js'

// The assistant's reversible masking of a customer's details, one turn's table at a time:
// - AC-1: property, a masked result revealed gives back the value with its token-shaped text neutralised, each value of
//   a listed kind has one token of its own kind, numbered from 1 in the order the turn met it, and no string of the
//   masked result holds a value masked by key.
// - AC-2: the key rules, field by field, under every mask.
// - AC-3: free text: the email and phone patterns, a table value standing whole, and reveal leaving an unminted token.

const KINDS = ['email', 'phone', 'address', 'postcode', 'name'] as const
type Kind = (typeof KINDS)[number]

/** Token-shaped text, as the module's TOKEN_SOURCE describes it; global here, for counting. */
const SHAPED = /\[(email|phone|address|postcode|name)-([1-9][0-9]*)\]/g

/** What neutralise is specified to do: the hyphen of every token-shaped match becomes a space. */
const neutral = (text: string): string => text.replace(SHAPED, '[$1 $2]')

/** The kind a key masks, by the Interface's key rules; undefined for every other key. */
function kindOfKey(key: string): Kind | undefined {
  if (/email$/i.test(key)) return 'email'
  if (/phone$/i.test(key)) return 'phone'
  if (key === 'addressLine1' || key === 'addressLine2') return 'address'
  if (key === 'postalCode') return 'postcode'
  if (key === 'firstName' || key === 'lastName') return 'name'
  return undefined
}

/** `value` with every string (never a key) passed through `f`. */
function mapStrings(value: unknown, f: (text: string) => string): unknown {
  if (typeof value === 'string') return f(value)
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, f))
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, f)]))
  }
  return value
}

function stringsOf(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(stringsOf)
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(stringsOf)
  return []
}

/** Every leaf that is not a string, by its path. */
function otherLeaves(value: unknown, path = '$'): Array<[string, unknown]> {
  if (Array.isArray(value)) return value.flatMap((item, i) => otherLeaves(item, `${path}[${i}]`))
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([k, v]) => otherLeaves(v, `${path}.${k}`))
  }
  return typeof value === 'string' ? [] : [[path, value]]
}

/** Every object's keys, by path. */
function keysOf(value: unknown, path = '$'): string[] {
  if (Array.isArray(value)) return value.flatMap((item, i) => keysOf(item, `${path}[${i}]`))
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([k, v]) => [`${path}.${k}`, ...keysOf(v, `${path}.${k}`)])
  }
  return []
}

/** The string leaves under a masking key, walked in step through the value and its masked copy. */
function keyedPairs(
  original: unknown,
  masked: unknown,
): Array<{ kind: Kind; value: string; masked: unknown }> {
  if (Array.isArray(original)) {
    return original.flatMap((item, i) => keyedPairs(item, (masked as unknown[] | undefined)?.[i]))
  }
  if (typeof original !== 'object' || original === null) return []
  const other = (masked ?? {}) as Record<string, unknown>
  return Object.entries(original).flatMap(([key, child]) => {
    const kind = kindOfKey(key)
    if (typeof child === 'string' && kind !== undefined) {
      return [{ kind, value: child, masked: other[key] }]
    }
    return keyedPairs(child, other[key])
  })
}

/** Whether `value` is exactly one token of `kind`. */
const isToken = (value: unknown, kind: Kind): boolean =>
  typeof value === 'string' && new RegExp(`^\\[${kind}-[1-9][0-9]*\\]$`).test(value)

interface Token {
  text: string
  kind: Kind
  n: number
}

function tokensIn(value: unknown): Token[] {
  return stringsOf(value).flatMap((text) =>
    [...text.matchAll(SHAPED)].map((m) => ({ text: m[0], kind: m[1] as Kind, n: Number(m[2]) })),
  )
}

const WORDISH = /[\p{L}\p{N}]/u

/** Whether `value` occurs in `text` with no letter or digit just before or after it. */
function standsWhole(text: string, value: string): boolean {
  for (let at = text.indexOf(value); at !== -1; at = text.indexOf(value, at + 1)) {
    const before = text[at - 1] ?? ''
    const after = text[at + value.length] ?? ''
    if (!WORDISH.test(before) && !WORDISH.test(after)) return true
  }
  return false
}

// ─── Generated customers ────────────────────────────────────────────────────────────────────────────────────────────

const email = fc
  .tuple(
    fc.stringMatching(/^[a-z][a-z0-9]{1,8}$/),
    fc.constantFrom('example', 'mail', 'shop'),
    fc.constantFrom('com', 'io', 'co.uk'),
  )
  .map(([local, domain, tld]) => `${local}@${domain}.${tld}`)

const sixDigits = fc.integer({ min: 100_000, max: 999_999 })
const phone = fc.oneof(
  sixDigits.map((n) => `+44 7700 ${n}`),
  sixDigits.map((n) => `07700 ${n}`),
  fc
    .tuple(fc.integer({ min: 100, max: 999 }), fc.integer({ min: 1000, max: 9999 }))
    .map(([a, b]) => `(555) ${a}-${b}`),
)

const street = fc
  .tuple(
    fc.integer({ min: 1, max: 299 }),
    fc.constantFrom('Acacia', 'Harbour', 'Mill', 'Orchard'),
    fc.constantFrom('Road', 'Lane', 'Street'),
  )
  .map(([n, a, b]) => `${n} ${a} ${b}`)

const secondLine = fc.integer({ min: 1, max: 40 }).map((n) => `Flat ${n}`)

const postcode = fc.oneof(
  fc
    .tuple(
      fc.constantFrom('SW1A', 'E1', 'N7', 'BS1', 'M15'),
      fc.integer({ min: 1, max: 9 }),
      fc.constantFrom('AA', 'BX', 'DJ', 'QT'),
    )
    .map(([outward, d, inward]) => `${outward} ${d}${inward}`),
  fc.integer({ min: 10_000, max: 99_999 }).map(String),
)

const tokenShaped = fc.constantFrom(
  '[email-1]',
  '[postcode-3]',
  '[phone-1]',
  '[address-1]',
  '[name-1]',
  '[email-12]',
)

/** A name, now and then written like a token, or shorter than three characters. */
const personName = fc.oneof(
  { weight: 6, arbitrary: fc.constantFrom('Ada', 'Grace', 'Linus', 'Maya', 'Okafor', 'Zhang') },
  { weight: 1, arbitrary: fc.constant('Bo') },
  { weight: 1, arbitrary: tokenShaped },
)

const person = fc.record({
  email: fc.oneof({ weight: 6, arbitrary: email }, { weight: 1, arbitrary: fc.constant('') }),
  customerEmail: fc.option(email, { nil: null }),
  receiptEmail: fc.option(email, { nil: null }),
  phone,
  shippingAddress: fc.record({
    firstName: personName,
    lastName: personName,
    company: fc.option(fc.constantFrom('Acme Ltd', 'Northwind'), { nil: null }),
    addressLine1: street,
    addressLine2: fc.option(secondLine, { nil: null }),
    city: fc.constantFrom('London', 'Leeds', 'Bristol'),
    region: fc.constantFrom('England', 'Avon'),
    postalCode: postcode,
    country: fc.constantFrom('GB', 'US'),
    phone: fc.option(phone, { nil: null }),
  }),
})

type Person = typeof person extends fc.Arbitrary<infer P> ? P : never

/** The details a person holds, as prose may quote them. */
const detailsOf = (p: Person): string[] =>
  [
    p.email,
    p.customerEmail,
    p.receiptEmail,
    p.phone,
    p.shippingAddress.firstName,
    p.shippingAddress.lastName,
    p.shippingAddress.addressLine1,
    p.shippingAddress.addressLine2,
    p.shippingAddress.postalCode,
    p.shippingAddress.phone,
  ].filter((v): v is string => typeof v === 'string' && v !== '')

const OTHER_TEXT = [
  'please',
  'leave it at the door',
  'order 1000 and 1001',
  '2026-11-05',
  'NYM-1001',
  '£1,234.56',
  '[see note]',
  '[email 1]',
  'thanks!',
]

/** Prose quoting some of `pool`, free-text emails and phones, token-shaped text and other words. */
const prose = (pool: string[]) =>
  fc
    .array(
      fc.oneof(fc.constantFrom(...pool), email, phone, tokenShaped, fc.constantFrom(...OTHER_TEXT)),
      { minLength: 1, maxLength: 8 },
    )
    .map((parts) => parts.join(' '))

/** A tool result: prose first (before the keyed fields it quotes), then the people, numbers and booleans. */
const resultValue = fc.array(person, { minLength: 1, maxLength: 3 }).chain((people) => {
  const pool = people.flatMap(detailsOf)
  return fc
    .record({
      summary: prose(pool),
      notes: fc.array(prose(pool), { minLength: people.length, maxLength: people.length }),
      totalMinor: fc.integer({ min: 0, max: 100_000 }),
      paid: fc.boolean(),
    })
    .map(({ summary, notes, totalMinor, paid }) => ({
      summary,
      items: people.map((p, i) => ({
        note: notes[i]!,
        id: `cus_${i}`,
        ...p,
        orders: i + 1,
        vip: i % 2 === 0,
      })),
      totalMinor,
      paid,
    }))
})

const anyMask = fc.subarray([...KINDS], { minLength: 1 })

describe('AC-1: a masked result reveals back to itself, one token per value', () => {
  it('AC-1: property: for any result of customers, prose and token-shaped text and any non-empty mask, revealArgs(result(v).value) equals v with its strings neutralised; every non-empty string under a key of a listed kind is one token of that kind; tokens map one to one onto values, numbered 1..n per kind across two results of the turn; masked equals the replacements; no string of the masked result holds a value masked by key, standing whole; under mask [] the value is unchanged and masked is 0', () => {
    fc.assert(
      fc.property(resultValue, resultValue, anyMask, (first, second, fields) => {
        const mask = createTurnMask(fields as MaskField[])
        const results = [first, second].map((v) => ({ v, r: mask.result(v) }))

        for (const { v, r } of results) {
          expect(mask.revealArgs(r.value)).toEqual(mapStrings(v, neutral))
          expect(r.masked).toBe(tokensIn(r.value).length)
          expect(keysOf(r.value)).toEqual(keysOf(v))
          expect(otherLeaves(r.value)).toEqual(otherLeaves(v))

          const keyed = keyedPairs(v, r.value)
          const listed = keyed.filter((p) => fields.includes(p.kind) && p.value !== '')
          expect(listed.filter((p) => !isToken(p.masked, p.kind))).toEqual([])
          expect(tokensIn(r.value).filter((t) => !fields.includes(t.kind))).toEqual([])

          const maskedByKey = keyed
            .filter((p) => fields.includes(p.kind))
            .map((p) => neutral(p.value))
            .filter((value) => value.length >= 3)
          const strings = stringsOf(r.value)
          expect(maskedByKey.filter((value) => strings.some((s) => standsWhole(s, value)))).toEqual(
            [],
          )
        }

        // One table for the turn: across both results each token stands for one value and each value has one token,
        // numbered from 1 per kind with no gap.
        const minted = new Map<string, Token>()
        for (const { r } of results) for (const t of tokensIn(r.value)) minted.set(t.text, t)
        for (const kind of KINDS) {
          const ofKind = [...minted.values()].filter((t) => t.kind === kind)
          const values = ofKind.map((t) => mask.reveal(t.text))
          expect(values.filter((value, i) => value === ofKind[i]!.text)).toEqual([])
          expect(new Set(values).size).toBe(ofKind.length)
          expect(ofKind.map((t) => t.n).sort((a, b) => a - b)).toEqual(ofKind.map((_, i) => i + 1))
        }

        const off = createTurnMask([]).result(first)
        expect(off.value).toEqual(first)
        expect(off.masked).toBe(0)
      }),
      { numRuns: 200 },
    )
  })

  it('AC-1: tokens count from 1 per kind in the order the turn first meets a value, keyed values before prose-only ones, and a later result of the same turn goes on counting', () => {
    const mask = createTurnMask(['email', 'postcode'])

    const first = mask.result({
      note: 'cc z@site.io about b@x.io',
      items: [
        { email: 'b@x.io', postalCode: 'E1 6AN' },
        { email: 'a@x.io', postalCode: 'SW1A 1AA' },
        { email: 'b@x.io', postalCode: 'E1 6AN' },
      ],
    })
    const second = mask.result({ items: [{ email: 'c@x.io' }, { email: 'a@x.io' }] })

    expect(first.value).toEqual({
      note: 'cc [email-3] about [email-1]',
      items: [
        { email: '[email-1]', postalCode: '[postcode-1]' },
        { email: '[email-2]', postalCode: '[postcode-2]' },
        { email: '[email-1]', postalCode: '[postcode-1]' },
      ],
    })
    expect(second.value).toEqual({ items: [{ email: '[email-4]' }, { email: '[email-2]' }] })
    expect([first.masked, second.masked]).toEqual([
      tokensIn(first.value).length,
      tokensIn(second.value).length,
    ])
  })

  it('AC-1: text written like a token in a result is neutralised, so revealing it never gives a customer’s value even when the turn minted that very token', () => {
    const mask = createTurnMask(['email'])

    const masked = mask.result({ email: 'ada@example.com', body: 'Email me at [email-1] please' })
    const revealed = mask.revealArgs(masked.value)

    expect(masked.value).toEqual({ email: '[email-1]', body: 'Email me at [email 1] please' })
    expect(revealed).toEqual({ email: 'ada@example.com', body: 'Email me at [email 1] please' })
    expect(JSON.stringify(revealed).split('ada@example.com').length - 1).toBe(1)
  })
})

describe('AC-2: the key rules', () => {
  const order = {
    id: 'ord_7f3a',
    orderNumber: 'NYM-1042',
    slug: 'linen-apron',
    email: 'buyer@example.com',
    customerEmail: 'customer@example.com',
    receiptEmail: 'receipts@example.com',
    phone: '+44 7700 900123',
    totalMinor: 1900,
    paid: true,
    shippingAddress: {
      firstName: 'Ada',
      lastName: 'Okafor',
      company: 'Acme Ltd',
      addressLine1: '12 Acacia Road',
      addressLine2: 'Flat 3',
      city: 'London',
      region: 'England',
      postalCode: 'SW1A 1AA',
      country: 'GB',
      phone: '07700 900456',
    },
    items: [{ name: 'Linen Apron', id: 'prod_1', slug: 'linen-apron', qty: 2 }],
  }

  /** [path, kind] for each customer field of `order`. */
  const FIELDS: Array<[(o: typeof order) => unknown, Kind]> = [
    [(o) => o.email, 'email'],
    [(o) => o.customerEmail, 'email'],
    [(o) => o.receiptEmail, 'email'],
    [(o) => o.phone, 'phone'],
    [(o) => o.shippingAddress.phone, 'phone'],
    [(o) => o.shippingAddress.addressLine1, 'address'],
    [(o) => o.shippingAddress.addressLine2, 'address'],
    [(o) => o.shippingAddress.postalCode, 'postcode'],
    [(o) => o.shippingAddress.firstName, 'name'],
    [(o) => o.shippingAddress.lastName, 'name'],
  ]

  /** The fields the store reasons over: never masked by key. */
  const KEPT: Array<(o: typeof order) => unknown> = [
    (o) => o.shippingAddress.city,
    (o) => o.shippingAddress.region,
    (o) => o.shippingAddress.country,
    (o) => o.shippingAddress.company,
    (o) => o.items[0]!.name,
    (o) => o.items[0]!.id,
    (o) => o.items[0]!.slug,
    (o) => o.id,
    (o) => o.orderNumber,
    (o) => o.slug,
  ]

  it('AC-2: under every mask, each customer field is one token of its kind exactly when its kind is listed and itself otherwise (names only when name is listed); city, region, country, company, a product’s name, ids, the order number and slugs are kept; every key, number and boolean is unchanged', () => {
    const masks = Array.from({ length: 2 ** KINDS.length }, (_, bits) =>
      KINDS.filter((_, i) => (bits & (1 << i)) !== 0),
    )
    for (const fields of masks) {
      const { value } = createTurnMask(fields).result(order)
      const masked = value as typeof order

      // A listed field reads as `token`, an unlisted one as itself.
      expect(
        FIELDS.map(([at, kind]) => (isToken(at(masked), kind) ? 'token' : at(masked))),
      ).toEqual(FIELDS.map(([at, kind]) => (fields.includes(kind) ? 'token' : at(order))))
      expect(KEPT.map((at) => at(masked))).toEqual(KEPT.map((at) => at(order)))
      expect(keysOf(masked)).toEqual(keysOf(order))
      expect(otherLeaves(masked)).toEqual(otherLeaves(order))
    }
  })

  it('AC-2: a ZIP the table holds may be replaced where it stands whole inside an order number, and is restored from it', () => {
    const mask = createTurnMask(['postcode'])
    const zipped = { orderNumber: 'NYM-10001', shippingAddress: { postalCode: '10001' } }

    const { value } = mask.result(zipped)

    expect(value).toEqual({
      orderNumber: 'NYM-[postcode-1]',
      shippingAddress: { postalCode: '[postcode-1]' },
    })
    expect(mask.revealArgs(value)).toEqual(zipped)
  })
})

describe('AC-3: free text', () => {
  const PHONES = [
    '+44 7700 900123',
    '07700 900123',
    '(555) 123-4567',
    '+1-555-123-4567',
    '0044 20 7946 0958',
  ]
  const NOT_PHONES = [
    '2026-11-05',
    'NYM-1001',
    '£1,234.56',
    '12345',
    '0.5',
    'order 1000 and 1001',
    'call 555-123-4567',
    '3f2b8c1e-9d4a-4c6b-8e2f-1a7b9c0d5e6f',
    'deadbeef-0123-4567-8901-abcdefabcdef',
  ]

  it('AC-3: each listed phone in a sentence becomes [phone-1] and is restored by reveal; the documented false positive 012345 678905 is masked too', () => {
    for (const number of [...PHONES, '012345 678905']) {
      const mask = createTurnMask(['phone'])
      const sentence = `Ring ${number} after six.`

      const masked = mask.text(sentence)

      expect(masked).toBe('Ring [phone-1] after six.')
      expect(mask.reveal(masked)).toBe(sentence)
    }
  })

  it('AC-3: dates, order numbers, money, short numbers, decimals, two order numbers, a US number without +, ( or 0, and UUIDs in a sentence are left as they are', () => {
    for (const text of NOT_PHONES) {
      const sentence = `See ${text} today.`
      expect(createTurnMask(['phone', 'email']).text(sentence)).toBe(sentence)
    }
  })

  it('AC-3: property: no UUID in prose is taken for a phone', () => {
    fc.assert(
      fc.property(fc.uuid(), (uuid) => {
        const sentence = `Reference ${uuid} for the refund.`
        expect(createTurnMask(['phone']).text(sentence)).toBe(sentence)
      }),
      { numRuns: 300 },
    )
  })

  it('AC-3: emails in a sentence are masked one token each and restored; text with an @ that is not an email is left', () => {
    const mask = createTurnMask(['email'])
    const sentence = 'Ask ada.k+shop@mail.example.co.uk or bo@x.io, not @handle or a@b.'

    const masked = mask.text(sentence)

    expect(masked).toBe('Ask [email-1] or [email-2], not @handle or a@b.')
    expect(mask.reveal(masked)).toBe(sentence)
  })

  it('AC-3: a phone pattern in a string with no whitespace (a path, an id) is not masked; the same number in a sentence is', () => {
    const mask = createTurnMask(['phone'])

    const { value } = mask.result({
      path: '/customers/+44-7700-900111/orders',
      ref: '07700900222',
      note: 'call +44-7700-900123 first',
    })

    expect(value).toEqual({
      path: '/customers/+44-7700-900111/orders',
      ref: '07700900222',
      note: 'call [phone-1] first',
    })
  })

  it('AC-3: a value the table holds is masked in a note only where it stands whole, and never when shorter than 3 characters', () => {
    const mask = createTurnMask(['postcode', 'name'])

    const { value } = mask.result({
      postalCode: 'SW1A 1AA',
      firstName: 'Ada',
      lastName: 'Al',
      note: 'Deliver to SW1A 1AA today, or XSW1A 1AA; ask Adams, Al or Ada.',
    })

    expect(value).toEqual({
      postalCode: '[postcode-1]',
      firstName: '[name-1]',
      lastName: '[name-2]',
      note: 'Deliver to [postcode-1] today, or XSW1A 1AA; ask Adams, Al or [name-1].',
    })
  })

  it('AC-3: reveal replaces only the tokens the turn minted: an unminted [email-9] stays as written', () => {
    const mask = createTurnMask(['email'])
    mask.result({ email: 'ada@example.com' })

    expect(mask.reveal('Write to [email-1], not [email-9] or [phone-1].')).toBe(
      'Write to ada@example.com, not [email-9] or [phone-1].',
    )
  })
})
