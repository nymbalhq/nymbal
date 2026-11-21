import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { createTurnMask, type MaskField } from './mask.js'

// A history change `{ path, from, to }` holds its values under `from` and `to`, whose keys name no kind: the path's
// last segment does. Read through the turn mask's result and reveal.

const FIELDS: ReadonlyArray<{ field: string; kind: MaskField }> = [
  { field: 'phone', kind: 'phone' },
  { field: 'email', kind: 'email' },
  { field: 'postalCode', kind: 'postcode' },
  { field: 'addressLine1', kind: 'address' },
  { field: 'firstName', kind: 'name' },
]

/** A value the free-text patterns do not find: a phone with no whitespace, or a bare word. */
const arbValue = fc.oneof(
  fc.integer({ min: 10_000_000_000, max: 99_999_999_999 }).map(String),
  fc.stringMatching(/^v[A-Za-z0-9]{2,12}$/),
)
const arbPrefix = fc.oneof(
  fc.constantFrom('', 'customer.', 'billing.address.'),
  fc.uuid().map((id) => `addresses.${id}.`),
)

interface Change {
  path: string
  from?: unknown
  to?: unknown
}

const tokenOf = (kind: MaskField): RegExp => new RegExp(`^\\[${kind}-[1-9][0-9]*\\]$`)

describe('masking a history change', () => {
  it('AC-10: property: under a mask listing the kind, a change whose path ends in the field has placeholders for its strings, its path unchanged, and reveal gives back each original, directly or after dotted prefixes', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...FIELDS),
        arbPrefix,
        arbValue,
        arbValue,
        fc.boolean(),
        ({ field, kind }, prefix, from, to, nested) => {
          const mask = createTurnMask([kind])
          const path = `${prefix}${field}`
          const held = { path, from, to }

          const { value } = mask.result(nested ? { history: [{ changes: [held] }] } : held)
          const change = (
            nested
              ? (value['history'] as Array<{ changes: Change[] }>)[0]!.changes[0]
              : (value as unknown as Change)
          ) as Change & { from: string; to: string }

          expect(change.path).toBe(path)
          expect(change.from).toMatch(tokenOf(kind))
          expect(change.to).toMatch(tokenOf(kind))
          expect(mask.reveal(change.from)).toBe(from)
          expect(mask.reveal(change.to)).toBe(to)
        },
      ),
      { numRuns: 200 },
    )
  })

  it('AC-11: only a change whose path names a listed kind is masked: a path naming no kind, or a kind the mask does not list, keeps its from and to, apart from the free-text patterns', () => {
    const mask = createTurnMask(['phone', 'email'])

    const { value } = mask.result({
      changes: [
        { path: 'customer.phone', from: '07700900123', to: '07700900456' },
        { path: 'title', from: 'Old title', to: 'call me at someone@example.com' },
        { path: 'addresses.a1.postalCode', from: 'E1 6AN', to: 'SW1A 1AA' },
        { path: 'firstName', from: 'Ada', to: 'Grace' },
      ],
    })

    expect(value['changes']).toEqual([
      { path: 'customer.phone', from: '[phone-1]', to: '[phone-2]' },
      { path: 'title', from: 'Old title', to: 'call me at [email-1]' },
      { path: 'addresses.a1.postalCode', from: 'E1 6AN', to: 'SW1A 1AA' },
      { path: 'firstName', from: 'Ada', to: 'Grace' },
    ])
  })

  it('AC-11: a null or absent from or to stays as it was, and the string beside it is masked', () => {
    const mask = createTurnMask(['phone', 'name'])

    const { value } = mask.result({
      changes: [
        { path: 'phone', from: null, to: '07700900123' },
        { path: 'phone', to: '07700900456' },
        { path: 'firstName', from: 'Ada', to: null },
      ],
    })

    const changes = value['changes'] as Change[]
    expect(changes[0]).toEqual({ path: 'phone', from: null, to: '[phone-1]' })
    expect(changes[1]).toEqual({ path: 'phone', to: '[phone-2]' })
    expect(Object.keys(changes[1]!)).toEqual(['path', 'to'])
    expect(changes[2]).toEqual({ path: 'firstName', from: '[name-1]', to: null })
  })

  it('AC-11: a value a change minted is masked where it repeats in text of the same result, whether the text comes before the change or after it', () => {
    const results = [
      (change: Change) => ({ summary: 'moved to E16AN from there', changes: [change] }),
      (change: Change) => ({ changes: [change], summary: 'moved to E16AN from there' }),
    ]
    for (const shape of results) {
      const mask = createTurnMask(['postcode'])

      const { value } = mask.result(shape({ path: 'postalCode', from: 'E16AN', to: 'SW1A1AA' }))

      const [change] = value['changes'] as Array<Change & { from: string }>
      expect(change!.from).toMatch(tokenOf('postcode'))
      expect(value['summary']).toBe(`moved to ${change!.from} from there`)
      expect(mask.reveal(value['summary'] as string)).toBe('moved to E16AN from there')
    }
  })
})
