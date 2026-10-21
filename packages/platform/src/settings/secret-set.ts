import { SECRET_MIN_LENGTH, type Logger } from '@nymbalhq/types'

// Every secret value the process has decrypted or been given through Settings, with its base64 forms, longest first so
// a value that contains another is replaced whole. Process-wide: a logger built anywhere scrubs what any store holds.
const secrets = new Set<string>()
let ordered: string[] = []

const MASK = '***'

/** Adds a value, and its base64 and base64url, to the set every scrub removes. Short values are not scrubbed. */
export function addSecret(value: string): void {
  if (value.length < SECRET_MIN_LENGTH) return
  const bytes = Buffer.from(value, 'utf8')
  const before = secrets.size
  for (const form of [value, bytes.toString('base64'), bytes.toString('base64url')]) {
    secrets.add(form)
  }
  if (secrets.size !== before) ordered = [...secrets].sort((a, b) => b.length - a.length)
}

/** `text` with every secret in the set replaced by `***`. */
export function scrub(text: string): string {
  let out = text
  for (const secret of ordered) {
    if (out.includes(secret)) out = out.split(secret).join(MASK)
  }
  return out
}

const MAX_DEPTH = 16

/**
 * A copy of `value` with every string scrubbed, deeply: plain objects, arrays and errors (their own properties,
 * message, stack and cause, keeping the prototype so serializers still see an error). Other class instances are kept
 * as they are.
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
