import bcrypt from 'bcryptjs'
import { createHash, createHmac, timingSafeEqual } from 'node:crypto'

// Password hashes imported from another platform, kept in `password_hash` as `legacy:<recipe>:<source hash>` and
// checked with that platform's own recipe until the store's sunset date. Only the shapes and costs the store accepts
// are ever checked: a stored value is re-accepted before any work it names is done.

export const LEGACY_PASSWORD_PREFIX = 'legacy:'

export type LegacyRecipe = 'wordpress'
export const LEGACY_RECIPES: readonly LegacyRecipe[] = ['wordpress']

/** What an imported customer holds until they set a password through a reset link. */
export const IMPORTED_NO_PASSWORD = 'IMPORTED_NO_PASSWORD'

/** The costliest bcrypt a store accepts from WordPress: 10 unless it opted into 11 or 12. */
export type LegacyMaxCost = 10 | 11 | 12

/** bcrypt hashes of `DUMMY_PASSWORD` (auth-service.ts) at costs 11 and 12, for padding a refusal to the opted-in cost. */
export const DUMMY_PASSWORD_HASH_11 = '$2a$11$VmTAbnd1RqURQKOAssksmuu6U7ybcrHj120/gGFPSZNgga4.BSLsu'
export const DUMMY_PASSWORD_HASH_12 = '$2a$12$7lNC/wUw/Uo.kmTJJEEIieFK.mcRaohe8hMLqD1jm6WKps1EDy.be'

/** phpass reads at most this many bytes of the posted password, so its work never grows past it. */
export const PHPASS_MAX_BYTES = 256
/** WordPress refuses a longer password outright, in every format. */
export const LEGACY_PASSWORD_MAX_BYTES = 4096

/** The phpass setting a refusal's padding runs: WordPress's count `B` and a fixed salt. */
export const DUMMY_PHPASS_SETTING = '$P$BnymbalDu'

const ITOA64 = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const PHPASS = /^\$P\$[./0-9A-Za-z]{31}$/
const BCRYPT = /^(\$wp)?\$2[aby]\$(\d{2})\$[./0-9A-Za-z]{53}$/
const WORDPRESS_HMAC_KEY = 'wp-sha384'
const BCRYPT_MAX_CODE_POINTS = 72
const DAY_MS = 24 * 60 * 60_000

export type LegacyAcceptance =
  | { ok: true; stored: string }
  | { ok: false; reason: 'format' | 'cost' }

/** The shapes WordPress writes and the store accepts: `$P$B` phpass, and `$wp$` or plain bcrypt at 10 up to `maxCost`. */
export function acceptLegacyHash(
  recipe: LegacyRecipe,
  hash: string,
  maxCost: LegacyMaxCost,
): LegacyAcceptance {
  if (!LEGACY_RECIPES.includes(recipe)) return { ok: false, reason: 'format' }
  const tagged = { ok: true as const, stored: `${LEGACY_PASSWORD_PREFIX}${recipe}:${hash}` }
  if (PHPASS.test(hash)) return hash[3] === 'B' ? tagged : { ok: false, reason: 'cost' }
  const bcryptShape = BCRYPT.exec(hash)
  if (bcryptShape === null) return { ok: false, reason: 'format' }
  const cost = Number(bcryptShape[2])
  return cost >= 10 && cost <= maxCost ? tagged : { ok: false, reason: 'cost' }
}

export function isLegacyPasswordHash(stored: string): boolean {
  return stored.startsWith(LEGACY_PASSWORD_PREFIX)
}

/** The config's `until`, a calendar date, as 00:00 UTC that day whatever the process's time zone. */
export function legacyUntilOf(until: string): Date {
  return new Date(`${until}T00:00:00.000Z`)
}

export function legacyWindowOpen(until: Date | undefined, now: Date): boolean {
  return until !== undefined && now < until
}

/** Whole days from `now` to `until`, a part day counted as one. */
export function daysUntil(until: Date, now: Date): number {
  return Math.ceil((until.getTime() - now.getTime()) / DAY_MS)
}

const PHP_TRIM = new Set([0x20, 0x0a, 0x0d, 0x09, 0x0b, 0x00])

/** PHP's trim(), which WordPress applies to the password as posted; a loop, so a long run of spaces costs one pass. */
export function phpTrim(s: string): string {
  let start = 0
  let end = s.length
  while (start < end && PHP_TRIM.has(s.charCodeAt(start))) start += 1
  while (end > start && PHP_TRIM.has(s.charCodeAt(end - 1))) end -= 1
  return s.slice(start, end)
}

/**
 * What a bcrypt compare is handed: the first 72 code points. bcrypt reads only the first 72 UTF-8 bytes, which those
 * always hold, so the answer is the whole string's; the cut keeps a long password from making the compare longer.
 */
export function bcryptCandidate(password: string): string {
  let end = 0
  for (let n = 0; n < BCRYPT_MAX_CODE_POINTS && end < password.length; n += 1) {
    end += password.codePointAt(end)! > 0xffff ? 2 : 1
  }
  return password.slice(0, end)
}

/** A cost-c compare is 2^(c - 10) cost-10 units. */
export function bcryptUnits(hash: string): number {
  const cost = /^\$2[aby]?\$(\d{2})\$/.exec(hash)
  return cost === null ? 0 : 2 ** (Number(cost[1]) - 10)
}

function encode64(input: Buffer, count: number): string {
  let output = ''
  let i = 0
  while (i < count) {
    let value = input[i++]!
    output += ITOA64[value & 0x3f]
    if (i < count) value |= input[i]! << 8
    output += ITOA64[(value >> 6) & 0x3f]
    if (i++ >= count) break
    if (i < count) value |= input[i]! << 16
    output += ITOA64[(value >> 12) & 0x3f]
    if (i++ >= count) break
    output += ITOA64[(value >> 18) & 0x3f]
  }
  return output
}

/** phpass `crypt_private` at count `B`: 1 + 2^13 MD5 digests. The setting is accepted before it gets here. */
export function phpass(setting: string, password: Buffer): string {
  let rounds = 1 << ITOA64.indexOf(setting[3]!)
  let digest = createHash('md5').update(setting.slice(4, 12)).update(password).digest()
  while (rounds > 0) {
    digest = createHash('md5').update(digest).update(password).digest()
    rounds -= 1
  }
  return setting.slice(0, 12) + encode64(digest, 16)
}

/** WordPress's pre-hash for `$wp` bcrypt: base64 of HMAC-SHA384 keyed `wp-sha384`. */
export function wordpressHmac(password: Buffer): string {
  return createHmac('sha384', WORDPRESS_HMAC_KEY).update(password).digest('base64')
}

/** PHP's addslashes(): a backslash before each `'`, `"` and `\`, and NUL as the two characters `\0`. */
export function phpAddSlashes(s: string): string {
  return s.replace(/['"\\\0]/g, (c) => (c === '\0' ? '\\0' : `\\${c}`))
}

/** The typed password as the legacy checks read it: as WordPress hashed it, and its UTF-8 bytes. */
export interface LegacyInput {
  /** Slashed as WordPress slashes `$_POST`, which its sign-in never unslashes, then PHP-trimmed (wp_authenticate). */
  posted: string
  bytes: Buffer
}

export function legacyInput(password: string): LegacyInput {
  const posted = phpTrim(phpAddSlashes(password))
  return { posted, bytes: Buffer.from(posted, 'utf8') }
}

/** What a legacy check spent, so a refusal can pad the rest of its ledger. */
export interface LegacyWork {
  /** Cost-10 units of the row's own bcrypt compare, 0 when none ran. */
  units: number
  /** A compare already received the request's candidate. */
  candidateSent: boolean
  phpass: boolean
  hmac: boolean
}

export const NO_LEGACY_WORK: LegacyWork = {
  units: 0,
  candidateSent: false,
  phpass: false,
  hmac: false,
}

/** The known-answer check with what it spent. A stored value the store would not accept answers false with no work. */
export async function checkLegacyPassword(
  stored: string,
  input: LegacyInput,
  maxCost: LegacyMaxCost,
): Promise<{ ok: boolean; work: LegacyWork }> {
  const refused = { ok: false, work: NO_LEGACY_WORK }
  const recipe = LEGACY_RECIPES.find((r) => stored.startsWith(`${LEGACY_PASSWORD_PREFIX}${r}:`))
  if (recipe === undefined) return refused
  const hash = stored.slice(`${LEGACY_PASSWORD_PREFIX}${recipe}:`.length)
  if (!acceptLegacyHash(recipe, hash, maxCost).ok) return refused
  if (input.bytes.length > LEGACY_PASSWORD_MAX_BYTES) return refused
  if (hash.startsWith('$P$')) {
    if (input.bytes.length > PHPASS_MAX_BYTES) return refused
    const computed = Buffer.from(phpass(hash, input.bytes))
    return {
      ok: timingSafeEqual(computed, Buffer.from(hash)),
      work: { ...NO_LEGACY_WORK, phpass: true },
    }
  }
  const work = {
    units: bcryptUnits(hash.replace(/^\$wp/, '')),
    candidateSent: true,
    phpass: false,
    hmac: false,
  }
  if (hash.startsWith('$wp')) {
    const ok = await bcrypt.compare(wordpressHmac(input.bytes), hash.slice(3))
    return { ok, work: { ...work, hmac: true } }
  }
  return { ok: await bcrypt.compare(bcryptCandidate(input.posted), hash), work }
}

/** Whether `password` is the one WordPress hashed into `stored`, by WordPress's own rule: slash, trim, then check. */
export async function verifyLegacyPassword(
  stored: string,
  password: string,
  maxCost: LegacyMaxCost,
): Promise<boolean> {
  return (await checkLegacyPassword(stored, legacyInput(password), maxCost)).ok
}
