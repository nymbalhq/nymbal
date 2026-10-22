import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { AdapterSetting } from '@nymbalhq/types'
import { COMMERCE_SLOTS } from '../adapters/registry.js'
import { fillFromSettings } from './resolve.js'

// P3-07 AC-2 (spec P3-07-secrets-settings, ruling 3, Decision 4): `fillFromSettings(slot, block, declared, rows, env)`
// resolves each declared path as `block[path] ?? env[decl.env] ?? row`, a pure function. Over generated blocks (dot
// paths nested as the config nests them), declarations, environments and decrypted rows for this slot and others:
// - every value the block has is in the output unchanged;
// - a declared path the block lacks takes its declared env when that is set, and a row of this slot only when both
//   lack it;
// - nothing else is added: no undeclared path, no row of another slot;
// - the block passed in is not changed.
// Kills: Settings overriding config or env, a declared env not honoured, undeclared keys injected, another slot's row
// used, the caller's block mutated.

/** Leaf paths only: none is a prefix of another, so each can be set in one nested block. */
const UNIVERSE = [
  'secretKey',
  'webhookSecret',
  'publishableKey',
  'apiKey',
  'baseUrl',
  'model',
  'host',
  'port',
  'smtp.user',
  'smtp.pass',
  'smtp.host',
] as const
const ENV_NAMES = ['P3_07_A', 'P3_07_B', 'P3_07_C', 'P3_07_D', 'P3_07_E', 'P3_07_F'] as const

type Row = { slot: string; path: string; value: string }

const valueArb = fc.oneof(fc.string({ minLength: 1, maxLength: 24 }), fc.integer())

const caseArb = fc
  .record({
    slot: fc.constantFrom(...COMMERCE_SLOTS),
    otherSlot: fc.constantFrom(...COMMERCE_SLOTS),
    blockPaths: fc.subarray([...UNIVERSE]),
    blockValues: fc.array(valueArb, { minLength: UNIVERSE.length, maxLength: UNIVERSE.length }),
    declaredPaths: fc.subarray([...UNIVERSE]),
    declaredEnv: fc.array(fc.option(fc.constantFrom(...ENV_NAMES), { nil: undefined }), {
      minLength: UNIVERSE.length,
      maxLength: UNIVERSE.length,
    }),
    secret: fc.array(fc.boolean(), { minLength: UNIVERSE.length, maxLength: UNIVERSE.length }),
    env: fc.dictionary(fc.constantFrom(...ENV_NAMES), fc.string({ minLength: 1, maxLength: 24 })),
    rows: fc.uniqueArray(
      fc.record({
        own: fc.boolean(),
        path: fc.constantFrom(...UNIVERSE),
        value: fc.string({ minLength: 1, maxLength: 24 }),
      }),
      { selector: (r) => `${r.own}:${r.path}`, maxLength: UNIVERSE.length * 2 },
    ),
  })
  .map((c) => {
    const block: Record<string, unknown> = {}
    c.blockPaths.forEach((path) => setPath(block, path, c.blockValues[UNIVERSE.indexOf(path)]))
    const used = new Set<string>()
    const declared: AdapterSetting[] = c.declaredPaths.map((path) => {
      const i = UNIVERSE.indexOf(path)
      const env = c.declaredEnv[i]
      const unique = env !== undefined && !used.has(env)
      if (unique) used.add(env)
      return {
        path,
        label: `Label for ${path}`,
        secret: c.secret[i]!,
        ...(unique && { env }),
      }
    })
    const other = c.otherSlot === c.slot ? `${c.slot}-other` : c.otherSlot
    const rows: Row[] = c.rows.map((r) => ({
      slot: r.own ? c.slot : other,
      path: r.path,
      value: r.value,
    }))
    return { slot: c.slot, block, declared, env: c.env as Record<string, string>, rows }
  })

function getPath(source: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>((at, key) => (at as Record<string, unknown> | undefined)?.[key], source)
}

function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.')
  let at = target
  for (const key of keys.slice(0, -1)) {
    if (typeof at[key] !== 'object' || at[key] === null) at[key] = {}
    at = at[key] as Record<string, unknown>
  }
  at[keys[keys.length - 1]!] = value
}

/** Every leaf of `value` as a dotted path. */
function leafPaths(value: unknown, prefix = ''): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return [prefix]
  return Object.entries(value).flatMap(([k, v]) =>
    leafPaths(v, prefix === '' ? k : `${prefix}.${k}`),
  )
}

describe('P3-07 AC-2: precedence is config, then environment, then Settings', () => {
  it('AC-2: the output equals the block wherever the block has a value', () => {
    fc.assert(
      fc.property(caseArb, ({ slot, block, declared, env, rows }) => {
        const out = fillFromSettings(slot, block, declared, rows, env)
        for (const path of leafPaths(block).filter((p) => p !== '')) {
          expect(getPath(out, path), path).toEqual(getPath(block, path))
        }
      }),
      { numRuns: 500 },
    )
  })

  it("AC-2: a declared path the block lacks takes its env when set, else this slot's row, else stays absent", () => {
    fc.assert(
      fc.property(caseArb, ({ slot, block, declared, env, rows }) => {
        const out = fillFromSettings(slot, block, declared, rows, env)
        for (const decl of declared) {
          const fromBlock = getPath(block, decl.path)
          const fromEnv = decl.env === undefined ? undefined : env[decl.env]
          const fromRow = rows.find((r) => r.slot === slot && r.path === decl.path)?.value
          expect(getPath(out, decl.path), decl.path).toEqual(fromBlock ?? fromEnv ?? fromRow)
        }
      }),
      { numRuns: 500 },
    )
  })

  it('AC-2: the output adds no undeclared path and no other slot’s row, and the block passed in is unchanged', () => {
    fc.assert(
      fc.property(caseArb, ({ slot, block, declared, env, rows }) => {
        const before = structuredClone(block)
        const out = fillFromSettings(slot, block, declared, rows, env)
        const allowed = new Set([...leafPaths(block), ...declared.map((d) => d.path)])
        const added = leafPaths(out).filter((p) => p !== '' && !allowed.has(p))
        expect(added).toEqual([])
        for (const path of UNIVERSE) {
          if (declared.some((d) => d.path === path) || getPath(block, path) !== undefined) continue
          expect(getPath(out, path), path).toBeUndefined()
        }
        expect(block).toEqual(before)
      }),
      { numRuns: 500 },
    )
  })
})
