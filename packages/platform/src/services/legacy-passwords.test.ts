import bcrypt from 'bcryptjs'
import fc from 'fast-check'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  acceptLegacyHash,
  isLegacyPasswordHash,
  LEGACY_PASSWORD_MAX_BYTES,
  LEGACY_PASSWORD_PREFIX,
  PHPASS_MAX_BYTES,
  verifyLegacyPassword,
} from './legacy-passwords.js'
import {
  arbitraryStored,
  borderShapes,
  expectedAcceptance,
  innerEdit,
  MAX_COSTS,
  nearValidStored,
  NOT_PHP_TRIM,
  outerWhitespace,
  tagged,
  vector,
  VECTORS,
  type MaxCost,
} from './fixtures/wordpress-vectors.js'

// A WordPress password hash kept with its recipe is checked by known answers from WordPress's own code, and the store
// accepts or trusts only the shapes WordPress writes at the costs it opted into. Bcrypt and MD5 run for real, through
// wrappers that count the work each call does, so a stored value whose parameters ask for more work than the store
// allows fails fast on a count rather than running 2^30 MD5 rounds.

const { work, counting } = vi.hoisted(() => {
  const work = { md5: 0, hmac: 0, compares: [] as number[], md5Budget: 8_193 }
  type Fn = (...a: unknown[]) => unknown
  return {
    work,
    counting: {
      bcrypt(real: Record<string, unknown>) {
        const getRounds = real['getRounds'] as (hash: string) => number
        const realCompare = real['compare'] as Fn
        const compare = (s: unknown, hash: unknown, ...rest: unknown[]) => {
          let rounds = -1
          try {
            rounds = getRounds(hash as string)
          } catch {
            // Not a bcrypt hash: bcrypt answers false at once.
          }
          work.compares.push(rounds)
          if (rounds > 12) {
            return Promise.reject(new Error(`bcrypt at cost ${rounds} is over any store's budget`))
          }
          return realCompare(s, hash, ...rest)
        }
        const wrapped = { ...real, compare }
        return { ...wrapped, default: wrapped }
      },
      crypto(real: Record<string, unknown>) {
        const realHash = real['createHash'] as Fn
        const realHmac = real['createHmac'] as Fn
        const createHash = (algorithm: string, ...rest: unknown[]) => {
          if (algorithm.toLowerCase() === 'md5') {
            work.md5 += 1
            if (work.md5 > work.md5Budget) {
              throw new Error(`more than ${work.md5Budget} MD5 digests in one check`)
            }
          }
          return realHash(algorithm, ...rest)
        }
        const createHmac = (algorithm: string, ...rest: unknown[]) => {
          work.hmac += 1
          return realHmac(algorithm, ...rest)
        }
        const wrapped = { ...real, createHash, createHmac }
        return { ...wrapped, default: wrapped }
      },
    },
  }
})

vi.mock('bcryptjs', async (importOriginal) =>
  counting.bcrypt(((await importOriginal()) as { default: Record<string, unknown> }).default),
)
vi.mock('node:crypto', async (importOriginal) =>
  counting.crypto((await importOriginal()) as Record<string, unknown>),
)
vi.mock('crypto', async (importOriginal) =>
  counting.crypto((await importOriginal()) as Record<string, unknown>),
)

beforeEach(() => {
  resetWork()
})

function resetWork(): void {
  work.md5 = 0
  work.hmac = 0
  work.compares = []
}

/** What one verify answered, or what it threw; the work counters then hold that verify's work alone. */
async function answerOf(stored: string, password: string, m: MaxCost): Promise<boolean | string> {
  resetWork()
  try {
    return await verifyLegacyPassword(stored, password, m)
  } catch (error) {
    return `threw ${String(error)}`
  }
}

const utf8Bytes = (s: string): number => Buffer.byteLength(s, 'utf8')

const SIGNABLE = VECTORS.filter((v) => v.nymbalVerifies)

describe('AC-1: known answers from WordPress', () => {
  it('AC-1: with maxCost 12 every WordPress-made vector verifies with its password, except phpass over 256 bytes, which does not', async () => {
    const answers: Array<[string, boolean | string]> = []
    for (const v of VECTORS) answers.push([v.name, await answerOf(tagged(v.hash), v.password, 12)])
    expect(answers).toEqual(VECTORS.map((v) => [v.name, v.nymbalVerifies]))
  }, 30_000)

  it('AC-1: a vector’s password with PHP-trim whitespace added at either end still verifies, as WordPress trims it; whitespace PHP keeps, and a NUL the slashing has made \\0, does not at either end', async () => {
    for (const v of SIGNABLE) {
      await fc.assert(
        fc.asyncProperty(outerWhitespace(v.password), async (typed) => {
          expect(
            await answerOf(tagged(v.hash), typed, 12),
            `${v.name}: ${JSON.stringify(typed)}`,
          ).toBe(true)
        }),
        { numRuns: 3 },
      )
      for (const ws of NOT_PHP_TRIM) {
        expect(
          [
            await answerOf(tagged(v.hash), `${ws}${v.password}`, 12),
            await answerOf(tagged(v.hash), `${v.password}${ws}`, 12),
          ],
          `${v.name} with ${JSON.stringify(ws)} at each end`,
        ).toEqual([false, false])
      }
    }
  }, 120_000)

  // WordPress hashes the password as its forms post it: `$_POST` is slashed (wp_magic_quotes) and the password field is
  // never unslashed, so `it's-me` was hashed as `it\'s-me`.
  it('AC-1: a typed it’s-me, say "hi", back\\slash or a NUL at the end verifies against the WordPress hash of its slashed text in each format, and neither the hash of the text as typed nor the slashed text typed verifies', async () => {
    const slashed = VECTORS.filter((v) => v.unslashedHash !== undefined)
    expect(slashed.map((v) => [v.format, v.password])).toEqual(
      expect.arrayContaining(
        (['phpass', 'wp-bcrypt', 'bcrypt'] as const).flatMap((format) =>
          [`it's-me`, 'say "hi"', 'back\\slash', 'nul-at-the-end\0']
            .filter((typed) => format === 'wp-bcrypt' || !typed.endsWith('\0'))
            .map((typed) => [format, typed]),
        ),
      ),
    )
    const answers: Array<[string, boolean | string, boolean | string, boolean | string]> = []
    for (const v of slashed) {
      answers.push([
        v.name,
        await answerOf(tagged(v.hash), v.password, 12),
        await answerOf(tagged(v.unslashedHash!), v.password, 12),
        await answerOf(tagged(v.hash), v.posted, 12),
      ])
    }
    expect(answers).toEqual(slashed.map((v) => [v.name, true, false, false]))
  }, 60_000)

  it('AC-1: a password one inner edit away (insert, delete, replace, case flip, an inner space) does not verify against any vector', async () => {
    for (const v of SIGNABLE) {
      await fc.assert(
        fc.asyncProperty(innerEdit(v.password), async (wrong) => {
          expect(
            await answerOf(tagged(v.hash), wrong, 12),
            `${v.name}: ${JSON.stringify(wrong)}`,
          ).toBe(false)
        }),
        { numRuns: 4 },
      )
    }
  }, 120_000)

  it('AC-1: phpass reads at most 256 bytes: the WordPress vector of exactly 256 bytes verifies and the one of 300 does not', async () => {
    const at256 = vector('phpass 256 bytes')
    const at300 = vector('phpass 300 bytes')
    expect([at256.bytes, at300.bytes]).toEqual([PHPASS_MAX_BYTES, PHPASS_MAX_BYTES + 44])
    expect([
      await answerOf(tagged(at256.hash), at256.password, 12),
      await answerOf(tagged(at300.hash), at300.password, 12),
    ]).toEqual([true, false])
  })

  // Bcrypt reads 72 bytes, so a plain bcrypt hash of 72 bytes matches any password that starts with them: only the
  // 4096-byte cap refuses the longer one.
  it('AC-1: a plain bcrypt legacy check accepts a password of exactly 4096 bytes after the trim and refuses one of 4097, both starting with the 72 bytes the hash was made from', async () => {
    const head = 'b'.repeat(72)
    const hash = await bcrypt.hash(head, 10)
    const of = (bytes: number) => `${head}${'c'.repeat(bytes - 72)}`
    expect([
      await answerOf(tagged(hash), of(LEGACY_PASSWORD_MAX_BYTES), 12),
      await answerOf(tagged(hash), ` ${of(LEGACY_PASSWORD_MAX_BYTES)}\t`, 12),
      await answerOf(tagged(hash), of(LEGACY_PASSWORD_MAX_BYTES + 1), 12),
    ]).toEqual([true, true, false])
  }, 30_000)

  // Bcrypt reads the first 72 bytes of what it is given; 72 whole code points hold at least 72 bytes, so handing it
  // the first 72 code points never changes an answer. Cutting by bytes or by UTF-16 units splits a character there.
  it('AC-1: for passwords of 60 to 300 code points with 2, 3 and 4-byte characters across the 72nd byte, a plain bcrypt legacy check answers as bcrypt does for the whole password, against a hash of it and of one differing only after the 72nd byte', async () => {
    const ascii = fc.constantFrom(
      ...'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789-'.split(''),
    )
    const wide = fc.constantFrom('é', 'ß', 'ж', '€', 'あ', '中', '🦊', '😀', '𝄞')
    const password = fc
      .record({
        prefix: fc.array(ascii, { minLength: 60, maxLength: 71 }),
        bridge: fc.array(wide, { minLength: 4, maxLength: 8 }),
        tail: fc.array(fc.oneof(ascii, wide), { minLength: 1, maxLength: 220 }),
      })
      .map(({ prefix, bridge, tail }) => [...prefix, ...bridge, ...tail].slice(0, 300))
      .filter((cps) => utf8Bytes(cps.slice(0, -1).join('')) > 72 && cps.length >= 60)
    await fc.assert(
      fc.asyncProperty(password, fc.constantFrom('Z', 'é', '🦊'), async (cps, last) => {
        const whole = cps.join('')
        const afterByte72 = [...cps.slice(0, -1), cps.at(-1) === last ? 'q' : last].join('')
        for (const hashed of [whole, afterByte72]) {
          const hash = await bcrypt.hash(hashed, 10)
          const expected = await bcrypt.compare(whole, hash)
          expect(
            await answerOf(tagged(hash), whole, 12),
            `${cps.length} code points against ${hashed === whole ? 'itself' : 'a later difference'}`,
          ).toBe(expected)
        }
      }),
      {
        numRuns: 10,
        // A cut by UTF-16 units changes an answer only where 71 one-byte characters meet a 4-byte one: the cut then ends
        // inside its surrogate pair, at the 72nd byte. A cut by bytes splits any multi-byte character there.
        examples: [
          [[...'a'.repeat(71), '🦊', 'é', '中', 'x'], 'Z'],
          [[...'b'.repeat(71), '𝄞', '𝄞', 'y'], '🦊'],
          [[...'c'.repeat(70), 'é', '€', 'z'], 'é'],
        ],
      },
    )
  }, 120_000)
})

describe('AC-2: only the shapes WordPress writes, at the costs the store opted into', () => {
  it('AC-2: over generated border shapes and arbitrary strings, for maxCost 10, 11 and 12, acceptLegacyHash never throws and accepts or refuses exactly as the rule says, with its reason', () => {
    fc.assert(
      fc.property(
        fc.oneof(borderShapes(), fc.string({ unit: 'binary', maxLength: 90 })),
        fc.constantFrom(...MAX_COSTS),
        (s, m) => {
          let got: { ok: true; stored: string } | { ok: false; reason: string } | string
          try {
            got = acceptLegacyHash('wordpress', s, m)
          } catch (error) {
            got = `threw ${String(error)}`
          }
          const want = expectedAcceptance(s, m)
          const label = `${JSON.stringify(s)} at maxCost ${m}`
          // Where the rule allows either reason, the answer's own reason is taken if it is one of the two.
          const reason =
            !want.ok && want.reason === 'either'
              ? typeof got === 'object' && !got.ok && ['format', 'cost'].includes(got.reason)
                ? got.reason
                : 'format or cost'
              : !want.ok
                ? want.reason
                : undefined
          expect(got, label).toEqual(
            want.ok
              ? { ok: true, stored: `${LEGACY_PASSWORD_PREFIX}wordpress:${s}` }
              : { ok: false, reason },
          )
        },
      ),
      { numRuns: 2_000 },
    )
  })

  it('AC-2: every $P$ count character from / to z is refused but B, every bcrypt cost from 04 to 31 is refused outside 10 to maxCost, and a valid hash with a space at either end is refused as format', () => {
    const phpass = vector('phpass ascii').hash
    const wp = vector('wp bcrypt 10 ascii').hash
    for (const m of MAX_COSTS) {
      for (let c = '/'.charCodeAt(0); c <= 'z'.charCodeAt(0); c += 1) {
        const s = `$P$${String.fromCharCode(c)}${phpass.slice(4)}`
        expect(acceptLegacyHash('wordpress', s, m).ok, s).toBe(s[3] === 'B')
      }
      for (let cost = 4; cost <= 31; cost += 1) {
        const cc = String(cost).padStart(2, '0')
        for (const s of [`$wp$2y$${cc}${wp.slice(9)}`, `$2y$${cc}${wp.slice(9)}`]) {
          expect(acceptLegacyHash('wordpress', s, m), s).toEqual(
            cost >= 10 && cost <= m
              ? { ok: true, stored: `${LEGACY_PASSWORD_PREFIX}wordpress:${s}` }
              : { ok: false, reason: 'cost' },
          )
        }
      }
      for (const s of [` ${wp}`, `${wp} `, ` ${phpass}`, `${phpass}\n`]) {
        expect(acceptLegacyHash('wordpress', s, m), JSON.stringify(s)).toEqual({
          ok: false,
          reason: 'format',
        })
      }
    }
  })

  it('AC-2: a tagged value is recognised by its prefix, and nothing else is', () => {
    fc.assert(
      fc.property(fc.string({ unit: 'binary', maxLength: 60 }), (s) => {
        expect(isLegacyPasswordHash(`${LEGACY_PASSWORD_PREFIX}${s}`)).toBe(true)
        expect(isLegacyPasswordHash(s)).toBe(s.startsWith(LEGACY_PASSWORD_PREFIX))
      }),
    )
    expect(LEGACY_PASSWORD_PREFIX).toBe('legacy:')
  })

  for (const m of MAX_COSTS) {
    it(`AC-2: at maxCost ${m}, every near-valid stored value (one field broken) with its vector’s right password verifies false, never throws, and does no bcrypt, MD5 or HMAC work`, async () => {
      const near = nearValidStored(m)
      const wrongly: string[] = []
      for (const n of near) {
        resetWork()
        const answer = await answerOf(n.stored, n.password, m)
        const did = { compares: work.compares.length, md5: work.md5, hmac: work.hmac }
        if (answer !== false || did.compares + did.md5 + did.hmac !== 0) {
          wrongly.push(`${n.label}: ${String(answer)}, ${JSON.stringify(did)}`)
        }
      }
      expect(near.length).toBeGreaterThan(40)
      expect(wrongly).toEqual([])
    }, 60_000)
  }

  it('AC-2: over arbitrary stored values (any text after legacy:, an unknown recipe, garbage, empty) verify answers false and never throws', async () => {
    await fc.assert(
      fc.asyncProperty(arbitraryStored, fc.constantFrom(...MAX_COSTS), async (stored, m) => {
        resetWork()
        expect(await answerOf(stored, VECTORS[0]!.password, m), JSON.stringify(stored)).toBe(false)
      }),
      { numRuns: 300 },
    )
  }, 60_000)
})
