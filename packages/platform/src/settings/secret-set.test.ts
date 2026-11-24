import { SECRET_MIN_LENGTH, type Logger } from '@nymbalhq/types'
import fc from 'fast-check'
import { describe, expect, it, vi } from 'vitest'
import { addSecret, scrub, scrubDeep, scrubbingLogger } from './secret-set.js'

// The set is process-wide and only grows, so every secret this file adds stays for the tests after it. Secrets are
// drawn from letters, digits and `<>{}` (and `*` only where a test is about the mask). Filler is punctuation only,
// outside every secret alphabet and outside base64 and base64url, so a filler string can never hold, or complete, any
// secret the process has added.
const LOWER = 'abcdefghijklmnopqrstuvwxyz'.split('')
const WIDE = [...LOWER, ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<>{}']
const PUNCT = '.:;!~#% ,?'.split('')

const secretArb = fc
  .array(fc.constantFrom(...LOWER), {
    minLength: SECRET_MIN_LENGTH,
    maxLength: SECRET_MIN_LENGTH + 12,
  })
  .map((cs) => cs.join(''))
const fillerArb = fc.array(fc.constantFrom(...PUNCT), { maxLength: 6 }).map((cs) => cs.join(''))
const wideArb = (minLength: number, maxLength: number): fc.Arbitrary<string> =>
  fc.array(fc.constantFrom(...WIDE), { minLength, maxLength }).map((cs) => cs.join(''))

/** The value as written and as base64 and base64url of its UTF-8 bytes: the three forms `addSecret` registers. */
const formsOf = (value: string): string[] => {
  const bytes = Buffer.from(value, 'utf8')
  return [value, bytes.toString('base64'), bytes.toString('base64url')]
}

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

describe('addSecret and scrub', () => {
  it('a value and its base64 and base64url forms are each replaced by the mask wherever they sit in a text', () => {
    fc.assert(
      fc.property(
        wideArb(SECRET_MIN_LENGTH, SECRET_MIN_LENGTH + 12),
        fillerArb,
        fillerArb,
        (secret, a, b) => {
          addSecret(secret)
          for (const form of formsOf(secret)) expect(scrub(`${a}${form}${b}`)).toBe(`${a}***${b}`)
        },
      ),
    )
  })

  it('base64url is registered in its own right: a value whose base64 has `+`, `/` or padding is scrubbed in base64url', () => {
    // '>>>?' encodes to 'Pj4+Pw==' in base64 and 'Pj4-Pw' in base64url; neither holds the other.
    const secret = '>>>?>>>?>>'
    addSecret(secret)
    const url = Buffer.from(secret, 'utf8').toString('base64url')
    expect(url).not.toBe(Buffer.from(secret, 'utf8').toString('base64'))
    expect(scrub(`token=${url};`)).toBe('token=***;')
  })

  it('a value shorter than the minimum length is not registered, in any form; one at the minimum is', () => {
    fc.assert(
      fc.property(wideArb(1, SECRET_MIN_LENGTH - 1), fillerArb, fillerArb, (short, a, b) => {
        addSecret(short)
        for (const form of formsOf(short)) expect(scrub(`${a}${form}${b}`)).toBe(`${a}${form}${b}`)
      }),
    )
    const exact = 'Q7>x{2}m'.slice(0, SECRET_MIN_LENGTH)
    addSecret(exact)
    expect(scrub(`[${exact}]`)).toBe('[***]')
  })

  it('a secret that holds another is replaced whole, whichever was added first', () => {
    fc.assert(
      fc.property(
        wideArb(SECRET_MIN_LENGTH, SECRET_MIN_LENGTH + 6),
        wideArb(1, 4),
        wideArb(1, 4),
        fillerArb,
        (inner, before, after, a) => {
          const outer = `${before}${inner}${after}`
          addSecret(inner)
          addSecret(outer)
          expect(scrub(`${a}${outer}${a}`)).toBe(`${a}***${a}`)
          expect(scrub(`${a}${inner}${a}`)).toBe(`${a}***${a}`)
        },
      ),
    )
  })

  it('a secret led by the mask character is not rebuilt by the mask and the text after it', () => {
    const secret = '*abcdefgh'
    addSecret(secret)
    expect(scrub(secret + secret.slice(1))).not.toContain(secret)
  })

  it('a secret holding the mask character is in no scrubbed text built from its own pieces', () => {
    // Letters `xyz` and `*` only, with at least one of each, so these secrets cannot match any other test's text.
    const starArb = fc
      .array(fc.constantFrom('x', 'y', 'z', '*'), {
        minLength: SECRET_MIN_LENGTH,
        maxLength: SECRET_MIN_LENGTH + 4,
      })
      .map((cs) => cs.join(''))
      .filter((s) => s.includes('*') && /[xyz]/.test(s))
    fc.assert(
      fc.property(
        starArb.chain((secret) =>
          fc.tuple(
            fc.constant(secret),
            fc.array(
              fc.oneof(
                fc.constant(secret),
                fc.integer({ min: 0, max: secret.length }).map((i) => secret.slice(i)),
                fc.integer({ min: 0, max: secret.length }).map((i) => secret.slice(0, i)),
              ),
              { minLength: 1, maxLength: 5 },
            ),
          ),
        ),
        ([secret, pieces]) => {
          addSecret(secret)
          expect(scrub(pieces.join(''))).not.toContain(secret)
        },
      ),
    )
  })

  it('every occurrence is replaced and the text between them is kept', () => {
    fc.assert(
      fc.property(
        secretArb,
        fc.array(fillerArb, { minLength: 2, maxLength: 5 }),
        (secret, gaps) => {
          addSecret(secret)
          expect(scrub(gaps.join(secret))).toBe(gaps.join('***'))
        },
      ),
    )
  })

  it('a text is scanned for each secret once while no registered form holds the mask character, and again once one does', async () => {
    // A fresh module, so the `*` secrets other tests add are not in its set.
    vi.resetModules()
    const fresh = await import('./secret-set.js')
    const plain = 'qrstuvwxqrst'
    const starred = '*qrstuvwx'
    const scansOf = (secret: string, text: string): number => {
      const includes = vi.spyOn(String.prototype, 'includes')
      try {
        fresh.scrub(text)
        return includes.mock.calls.filter(([arg]) => arg === secret).length
      } finally {
        includes.mockRestore()
      }
    }
    fresh.addSecret(plain)
    expect(fresh.scrub(`.${plain}.`)).toBe('.***.')
    expect(scansOf(plain, `.${plain}.`)).toBe(1)
    fresh.addSecret(starred)
    expect(scansOf(plain, `.${plain}.`)).toBe(2)
  })

  it('with no secret registered, scrubDeep returns the value itself', async () => {
    vi.resetModules()
    const fresh = await import('./secret-set.js')
    const value = { a: 'text', b: [1, { c: 'more' }] }
    expect(fresh.scrubDeep(value)).toBe(value)
    fresh.addSecret('qrstuvwxqrst')
    expect(fresh.scrubDeep(value)).not.toBe(value)
    expect(fresh.scrubDeep(value)).toEqual(value)
  })
})

describe('scrubDeep beyond objects, arrays, Maps and Sets', () => {
  it('an error comes back with the same prototype and own properties, its message, stack, cause and fields scrubbed', () => {
    const secret = 'Err0rSecretValue'
    addSecret(secret)
    class GatewayError extends Error {
      code = `code ${secret}`
      hint: string | undefined = undefined
    }
    const cause = new TypeError(`inner ${secret}`)
    const error = new GatewayError(`outer ${secret}`, { cause })
    const out = scrubDeep(error)
    expect(out === error, 'the copy is a new error').toBe(false)
    expect(Object.getPrototypeOf(out)).toBe(GatewayError.prototype)
    expect(out.message).toBe('outer ***')
    expect(out.code).toBe('code ***')
    expect(out.stack).toBe(error.stack?.replaceAll(secret, '***'))
    expect(out.stack).not.toContain(secret)
    const outCause = out.cause as Error
    expect(Object.getPrototypeOf(outCause)).toBe(TypeError.prototype)
    expect(outCause.message).toBe('inner ***')
    expect(Reflect.ownKeys(out).sort()).toEqual(Reflect.ownKeys(error).sort())
    // Each own property keeps the original's flags, so JSON shows the same fields and a serializer may still set or
    // delete one.
    const flags = (of: object, keys: PropertyKey[]): unknown[] =>
      keys.map((key) => {
        const d = Object.getOwnPropertyDescriptor(of, key)
        return [key, d?.enumerable, d?.configurable]
      })
    const writable = (of: object, keys: PropertyKey[]): unknown[] =>
      keys.map((key) => [key, Object.getOwnPropertyDescriptor(of, key)?.writable])
    const keys = Reflect.ownKeys(error)
    // V8 keeps an error's stack as an accessor, which has no writable flag; the copy holds it as a value.
    const dataKeys = keys.filter((key) => 'value' in Object.getOwnPropertyDescriptor(error, key)!)
    expect(flags(out, keys)).toEqual(flags(error, keys))
    expect(writable(out, dataKeys)).toEqual(writable(error, dataKeys))
    expect(Object.keys(out)).toEqual(Object.keys(error))
    expect(JSON.stringify(out)).toBe(JSON.stringify({ code: 'code ***' }))
    expect(error.message).toBe(`outer ${secret}`)
  })

  it('an error whose message, stack and cause are inherited gets each as an own, non-enumerable, scrubbed property', () => {
    const secret = 'Inher1tedSecret'
    addSecret(secret)
    class FixedError extends Error {}
    for (const key of ['message', 'stack', 'cause']) {
      Object.defineProperty(FixedError.prototype, key, { get: () => `${key} ${secret}` })
    }
    const error = new FixedError()
    delete (error as { stack?: string }).stack
    const out = scrubDeep(error)
    expect([out.message, out.stack, out.cause]).toEqual(['message ***', 'stack ***', 'cause ***'])
    expect(['message', 'stack', 'cause'].filter((key) => Object.hasOwn(out, key))).toEqual([
      'message',
      'stack',
      'cause',
    ])
    expect(Object.keys(out)).toEqual([])
  })

  it('an error with no cause gets none on its copy', () => {
    addSecret('nocausesecret')
    const out = scrubDeep(new Error('token nocausesecret'))
    expect(out.message).toBe('token ***')
    expect(Object.hasOwn(out, 'cause')).toBe(false)
  })

  it('an error that is its own cause is copied with the cause pointing at the copy', () => {
    addSecret('selferrorsecret')
    const error = new Error('token selferrorsecret')
    error.cause = error
    const out = scrubDeep(error)
    expect(out === error, 'the copy is a new error').toBe(false)
    expect(out.cause === out, "the copy's cause is the copy").toBe(true)
    expect(out.message).toBe('token ***')
  })

  it('an object reached twice is copied once, and nulls, numbers, booleans and undefined are kept', () => {
    addSecret('sharedsecret')
    const shared = { note: 'sharedsecret' }
    const loop: unknown[] = ['sharedsecret']
    loop.push(loop)
    const out = scrubDeep({ a: shared, b: [shared], loop, n: null, k: 3, t: true, u: undefined })
    expect(out.a).toStrictEqual({ note: '***' })
    expect(out.b[0] === out.a, 'both paths lead to one copy').toBe(true)
    expect(out.a === shared, 'the copy is new').toBe(false)
    expect(out.loop[0]).toBe('***')
    expect(out.loop[1] === out.loop, 'an array that holds itself holds its copy').toBe(true)
    expect([out.n, out.k, out.t, out.u]).toStrictEqual([null, 3, true, undefined])
  })

  it('a null-prototype object is scrubbed and a class instance is kept as it is', () => {
    addSecret('protosecret1')
    const bare = Object.assign(Object.create(null) as Record<string, string>, {
      note: 'protosecret1',
    })
    class Holder {
      note = 'protosecret1'
    }
    const holder = new Holder()
    const out = scrubDeep({ bare, holder })
    expect({ ...out.bare }).toStrictEqual({ note: '***' })
    expect(out.holder === holder, 'a class instance is the same object').toBe(true)
  })

  it('objects 16 levels deep are scrubbed and those deeper are kept as they are, through every kind of container', () => {
    addSecret('deepsecret1')
    // Each level wraps the one inside it in the next kind in turn, so every kind of container counts a level.
    const kinds: { wrap: (inner: unknown) => object; unwrap: (outer: object) => unknown }[] = [
      { wrap: (inner) => [inner], unwrap: (outer) => (outer as unknown[])[0] },
      { wrap: (inner) => ({ inner }), unwrap: (outer) => (outer as { inner: unknown }).inner },
      {
        wrap: (inner) => new Map([['v', inner]]),
        unwrap: (outer) => (outer as Map<string, unknown>).get('v'),
      },
      {
        wrap: (inner) => new Map([[inner, 'k']]),
        unwrap: (outer) => [...(outer as Map<unknown, string>).keys()][0],
      },
      { wrap: (inner) => new Set([inner]), unwrap: (outer) => [...(outer as Set<unknown>)][0] },
      {
        wrap: (inner) => new Error('e', { cause: inner }),
        unwrap: (outer) => (outer as Error).cause,
      },
    ]
    const kind = (i: number): (typeof kinds)[number] => kinds[i % kinds.length]!
    const nest = (levels: number): object => {
      let value: object = ['deepsecret1']
      for (let i = levels - 2; i >= 0; i -= 1) value = kind(i).wrap(value)
      return value
    }
    const innermost = (value: object, levels: number): unknown => {
      let at: unknown = value
      for (let i = 0; i < levels - 1; i += 1) at = kind(i).unwrap(at as object)
      return at
    }
    // 17 levels sit at depths 0 to 16, the last depth still copied.
    expect(innermost(scrubDeep(nest(17)), 17)).toStrictEqual(['***'])
    const deeper = nest(18)
    expect(
      innermost(scrubDeep(deeper), 18) === innermost(deeper, 18),
      'the 18th level is the original',
    ).toBe(true)
  })
})

type Entry = { level: string; bindings: Record<string, unknown>[]; args: unknown[] }

/** A logger that records each call, with the bindings of every child above it. */
function recorder(entries: Entry[], bindings: Record<string, unknown>[] = []): Logger {
  const at =
    (level: string) =>
    (...args: unknown[]): void => {
      entries.push({ level, bindings, args })
    }
  return {
    trace: at('trace'),
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: (b) => recorder(entries, [...bindings, b]),
  }
}

const LEVELS = ['trace', 'debug', 'info', 'warn', 'error'] as const

describe('scrubbingLogger', () => {
  it('each level reaches the same level of the wrapped logger with the object and the message scrubbed', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...LEVELS),
        secretArb,
        fillerArb,
        fillerArb,
        (level, secret, a, b) => {
          addSecret(secret)
          const entries: Entry[] = []
          const log = scrubbingLogger(recorder(entries))
          const obj = { note: `${a}${secret}${b}`, n: 1 }
          log[level](obj, `${b}${secret}${a}`)
          log[level]({ note: `${a}${secret}` })
          expect(entries).toStrictEqual([
            { level, bindings: [], args: [{ note: `${a}***${b}`, n: 1 }, `${b}***${a}`] },
            { level, bindings: [], args: [{ note: `${a}***` }] },
          ])
          expect(obj.note).toBe(`${a}${secret}${b}`)
        },
      ),
    )
  })

  it("a child's bindings are scrubbed, and the child and its children scrub what they log", () => {
    fc.assert(
      fc.property(fc.constantFrom(...LEVELS), secretArb, fillerArb, (level, secret, a) => {
        addSecret(secret)
        const entries: Entry[] = []
        const grandchild = scrubbingLogger(recorder(entries))
          .child({ token: `${a}${secret}` })
          .child({ keys: [secret] })
        grandchild[level]({ x: secret }, secret)
        expect(entries).toStrictEqual([
          {
            level,
            bindings: [{ token: `${a}***` }, { keys: ['***'] }],
            args: [{ x: '***' }, '***'],
          },
        ])
      }),
    )
  })
})
