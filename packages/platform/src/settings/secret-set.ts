import { SECRET_MIN_LENGTH, type Logger } from '@nymbalhq/types'

// Every secret value the process has decrypted or been given through Settings, with its base64 forms, longest first so
// a value that contains another is replaced whole. Process-wide: a logger built anywhere scrubs what any store holds.
const secrets = new Set<string>()
let ordered: string[] = []
// Whether some form holds the mask character: only such a secret can be rebuilt by a mask and the text beside it.
let maskable = false

const MASK = '***'

/** Adds a value, and its base64 and base64url, to the set every scrub removes. Short values are not scrubbed. */
export function addSecret(value: string): void {
  if (value.length < SECRET_MIN_LENGTH) return
  const bytes = Buffer.from(value, 'utf8')
  const before = secrets.size
  for (const form of [value, bytes.toString('base64'), bytes.toString('base64url')]) {
    secrets.add(form)
    if (form.includes('*')) maskable = true
  }
  if (secrets.size !== before) ordered = [...secrets].sort((a, b) => b.length - a.length)
}

/** `text` with every secret in the set replaced by `***`. */
export function scrub(text: string): string {
  // A secret holding `*` can be rebuilt from a mask and the text beside it (`*abcdefgh` then `abcdefgh` becomes
  // `***abcdefgh`), so while such a secret is registered, passes repeat until one replaces nothing. Every form is
  // longer than the mask, so each replacement shortens the text and the loop ends. Without one, a mask holds no
  // secret's character at its edges and one pass is enough.
  let out = text
  for (;;) {
    let replaced = false
    for (const secret of ordered) {
      if (!out.includes(secret)) continue
      out = out.split(secret).join(MASK)
      replaced = true
    }
    if (!replaced || !maskable) return out
  }
}

const MAX_DEPTH = 16

/**
 * A copy of `value` with every string scrubbed, deeply: plain objects, arrays, Maps, Sets and errors (their own
 * properties, message, stack and cause, keeping the prototype so serializers still see an error). Other class
 * instances are kept as they are.
 * A Map's object keys come back as new (scrubbed) objects, so a lookup by the original key object misses on the copy.
 */
export function scrubDeep<T>(value: T): T {
  if (ordered.length === 0) return value
  return copy(value, 0, new WeakMap()) as T
}

function copy(value: unknown, depth: number, seen: WeakMap<object, unknown>): unknown {
  if (typeof value === 'string') return scrub(value)
  if (typeof value !== 'object' || value === null || depth > MAX_DEPTH) return value
  const known = seen.get(value)
  if (known !== undefined) return known
  if (Array.isArray(value)) {
    const out: unknown[] = []
    seen.set(value, out)
    for (const item of value) out.push(copy(item, depth + 1, seen))
    return out
  }
  if (value instanceof Error) {
    const out = Object.create(Object.getPrototypeOf(value) as object) as Record<
      PropertyKey,
      unknown
    >
    seen.set(value, out)
    const keys = new Set<PropertyKey>([...Reflect.ownKeys(value), 'message', 'stack', 'cause'])
    for (const key of keys) {
      const own = Object.getOwnPropertyDescriptor(value, key)
      const inner = (value as unknown as Record<PropertyKey, unknown>)[key]
      if (own === undefined && inner === undefined) continue
      Object.defineProperty(out, key, {
        value: copy(inner, depth + 1, seen),
        enumerable: own?.enumerable ?? false,
        writable: true,
        configurable: true,
      })
    }
    return out
  }
  if (value instanceof Map) {
    const out = new Map<unknown, unknown>()
    seen.set(value, out)
    for (const [key, inner] of value)
      out.set(copy(key, depth + 1, seen), copy(inner, depth + 1, seen))
    return out
  }
  if (value instanceof Set) {
    const out = new Set<unknown>()
    seen.set(value, out)
    for (const member of value) out.add(copy(member, depth + 1, seen))
    return out
  }
  const proto = Object.getPrototypeOf(value) as object | null
  if (proto !== Object.prototype && proto !== null) return value
  const out: Record<string, unknown> = {}
  seen.set(value, out)
  for (const [key, inner] of Object.entries(value)) out[scrub(key)] = copy(inner, depth + 1, seen)
  return out
}

/** `logger` with every record scrubbed on the way in: the object, the message and every child's bindings. */
export function scrubbingLogger(logger: Logger): Logger {
  const at =
    (level: 'trace' | 'debug' | 'info' | 'warn' | 'error') =>
    (obj: unknown, msg?: string): void => {
      if (msg === undefined) logger[level](scrubDeep(obj))
      else logger[level](scrubDeep(obj), scrub(msg))
    }
  return {
    trace: at('trace'),
    debug: at('debug'),
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    child: (bindings) => scrubbingLogger(logger.child(scrubDeep(bindings))),
  }
}
