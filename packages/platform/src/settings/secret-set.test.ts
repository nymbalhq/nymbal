import { SECRET_MIN_LENGTH } from '@nymbalhq/types'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { addSecret, scrubDeep } from './secret-set.js'

// Secrets are lowercase letters (never `*`, which the mask could recreate). Filler is punctuation only, outside the
// secret alphabet and outside base64 and base64url, so a filler string can never hold any secret the process has added.
const LOWER = 'abcdefghijklmnopqrstuvwxyz'.split('')
const PUNCT = '.:;!~#% ,?'.split('')

const secretArb = fc
  .array(fc.constantFrom(...LOWER), {
    minLength: SECRET_MIN_LENGTH,
    maxLength: SECRET_MIN_LENGTH + 12,
  })
  .map((cs) => cs.join(''))
const fillerArb = fc.array(fc.constantFrom(...PUNCT), { maxLength: 6 }).map((cs) => cs.join(''))

type Tree = string | Tree[] | { [k: string]: Tree } | Map<string, Tree> | Set<Tree>

/** A nesting of plain objects, arrays, Maps and Sets (depth at most 4) whose strings may hold `secret`. */
function treeArb(secret: string): fc.Arbitrary<Tree> {
  const holder = fc.tuple(fillerArb, fillerArb).map(([a, b]) => `${a}${secret}${b}`)
  const str = fc.oneof(fillerArb, holder)
  const { tree } = fc.letrec<{ tree: Tree }>((tie) => ({
    tree: fc.oneof(
      { depthSize: 'small', maxDepth: 4 },
      str,
      fc.array(tie('tree'), { maxLength: 3 }),
      fc.dictionary(str, tie('tree'), { maxKeys: 3 }),
      fc.array(fc.tuple(str, tie('tree')), { maxLength: 3 }).map((es) => new Map(es)),
      fc.array(tie('tree'), { maxLength: 3 }).map((ms) => new Set(ms)),
    ),
  }))
  // The secret always sits inside a Map key, a Map value and a Set member somewhere in the value.
  const carrier = holder.map((h) => new Map<string, Tree>([[h, new Set<Tree>([h])]]))
  return fc.tuple(tree, carrier, fc.integer({ min: 0, max: 3 })).map(([t, c, shape]): Tree => {
    if (shape === 0) return { tree: t, carrier: c }
    if (shape === 1) return [t, c]
    if (shape === 2)
      return new Map<string, Tree>([
        ['tree', t],
        ['carrier', c],
      ])
    return new Set<Tree>([t, c])
  })
}

/** Maps as entry arrays, Sets as arrays, so JSON shows what a Map or Set holds. */
function toPlain(value: unknown): unknown {
  if (value instanceof Map) return [...value].map(([k, v]) => [toPlain(k), toPlain(v)])
  if (value instanceof Set) return [...value].map(toPlain)
  if (Array.isArray(value)) return value.map(toPlain)
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toPlain(v)]))
  }
  return value
}

/** Every string in `value`, keys included. */
function stringsOf(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value)
  else if (value instanceof Map) for (const [k, v] of value) (stringsOf(k, out), stringsOf(v, out))
  else if (value instanceof Set || Array.isArray(value)) for (const m of value) stringsOf(m, out)
  else if (typeof value === 'object' && value !== null) {
    for (const [k, v] of Object.entries(value)) (out.push(k), stringsOf(v, out))
  }
  return out
}

describe('scrubDeep', () => {
  it('AC-1: a secret inside any nesting of objects, arrays, Maps and Sets is scrubbed and other strings are kept', () => {
    fc.assert(
      fc.property(
        secretArb.chain((secret) => fc.tuple(fc.constant(secret), treeArb(secret))),
        ([secret, value]) => {
          addSecret(secret)
          const out = scrubDeep(value)
          expect(JSON.stringify(toPlain(out))).not.toContain(secret)
          const kept = new Set(stringsOf(out))
          const clean = stringsOf(value).filter((s) => !s.includes(secret))
          expect(clean.filter((s) => !kept.has(s))).toEqual([])
        },
      ),
    )
  })

  it('AC-2: a Map comes back as a new Map of the same size and the input Map is not modified', () => {
    fc.assert(
      fc.property(
        secretArb,
        fc.array(fc.tuple(fillerArb, fc.boolean(), fillerArb), { minLength: 1, maxLength: 6 }),
        (secret, rows) => {
          addSecret(secret)
          // The index keeps every key distinct before and after scrubbing.
          const entries = rows.map(([f, hold, v], i): [string, string] => [
            `${i}${f}${hold ? secret : ''}`,
            `${v}${hold ? secret : ''}`,
          ])
          const input = new Map(entries)
          const out = scrubDeep(input)
          expect(out).not.toBe(input)
          expect(out).toBeInstanceOf(Map)
          expect(out.size).toBe(input.size)
          expect([...input]).toEqual(entries)
        },
      ),
    )
  })

  it('AC-2: a Set comes back as a new Set of the same size and the input Set is not modified', () => {
    fc.assert(
      fc.property(
        secretArb,
        fc.array(fc.tuple(fillerArb, fc.boolean()), { minLength: 1, maxLength: 6 }),
        (secret, rows) => {
          addSecret(secret)
          const members = rows.map(([f, hold], i) => `${i}${f}${hold ? secret : ''}`)
          const input = new Set(members)
          const out = scrubDeep(input)
          expect(out).not.toBe(input)
          expect(out).toBeInstanceOf(Set)
          expect(out.size).toBe(input.size)
          expect([...input]).toEqual(members)
        },
      ),
    )
  })

  it('AC-3: a Map that holds itself is copied with its self-reference pointing at the copy', () => {
    addSecret('selfmapsecret')
    const input = new Map<string, unknown>([['note', 'token selfmapsecret']])
    input.set('k', input)
    const out = scrubDeep(input)
    // Identities as booleans: printing a self-referential Map in a failure message overflows the stack.
    expect(out === input, 'the copy is a new Map').toBe(false)
    expect(out.get('k') === out, "the copy's self-reference is the copy").toBe(true)
    expect(out.get('note')).toBe('token ***')
  })

  it('AC-3: a Set that holds itself is copied with its self-reference pointing at the copy', () => {
    addSecret('selfsetsecret')
    const input = new Set<unknown>(['token selfsetsecret'])
    input.add(input)
    const out = scrubDeep(input)
    expect(out === input, 'the copy is a new Set').toBe(false)
    expect(out.has(out), "the copy's self-reference is the copy").toBe(true)
    expect(out.has(input)).toBe(false)
    expect(out.has('token ***')).toBe(true)
  })
})
