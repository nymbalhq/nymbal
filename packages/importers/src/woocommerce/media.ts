import { createHash } from 'node:crypto'
import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import type { MediaStorage } from '@nymbalhq/types'
import { imageSources } from './refs.js'

const TIMEOUT_MS = 15_000
const MAX_REDIRECTS = 3
const SUPPORTED_TYPES: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

export interface DownloadedMedia {
  url: string
  altText: string
}

/** Which image URLs the import may request. */
export interface ImagePolicy {
  /** Every address `host` resolves to; the system resolver's by default. */
  lookup?: (host: string) => Promise<string[]>
  /** The WooCommerce store's own host name, requested whatever its address (a store on the local network). */
  allowHost?: string
}

async function systemLookup(host: string): Promise<string[]> {
  return (await dnsLookup(host, { all: true })).map((a) => a.address)
}

/** The IPv4 ranges that are not public, as [base address, prefix length]. */
const BLOCKED_V4: ReadonlyArray<readonly [number, number]> = [
  [ipv4ToNumber('0.0.0.0'), 8], // unspecified, "this network"
  [ipv4ToNumber('10.0.0.0'), 8],
  [ipv4ToNumber('100.64.0.0'), 10], // carrier-grade NAT
  [ipv4ToNumber('127.0.0.0'), 8],
  [ipv4ToNumber('169.254.0.0'), 16], // link-local, cloud metadata
  [ipv4ToNumber('172.16.0.0'), 12],
  [ipv4ToNumber('192.168.0.0'), 16],
]

function ipv4ToNumber(dotted: string): number {
  return dotted.split('.').reduce((acc, part) => acc * 256 + Number(part), 0)
}

function isPublicV4(n: number): boolean {
  return BLOCKED_V4.every(([base, prefix]) => {
    const size = 2 ** (32 - prefix)
    return Math.floor(n / size) !== Math.floor(base / size)
  })
}

/** The eight 16-bit groups of an IPv6 address `isIP` accepted, a trailing dotted quad included. */
function ipv6Groups(ip: string): number[] {
  let text = ip
  const quad = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)
  if (quad) {
    const n = ipv4ToNumber(quad[1]!)
    text = `${text.slice(0, quad.index)}${Math.floor(n / 65536).toString(16)}:${(n % 65536).toString(16)}`
  }
  const [head, tail] = text.split('::') as [string, string | undefined]
  const parse = (part: string) => (part === '' ? [] : part.split(':').map((g) => parseInt(g, 16)))
  const front = parse(head)
  if (tail === undefined) return front
  const back = parse(tail)
  return [...front, ...new Array<number>(8 - front.length - back.length).fill(0), ...back]
}

/**
 * Whether an address is on the public internet: not loopback, private (10/8, 172.16/12, 192.168/16), shared
 * (100.64/10), link-local (169.254/16, fe80::/10), unique-local (fc00::/7), unspecified, or an IPv4-mapped form of
 * these. Anything that is not an IP address is not public.
 */
export function isPublicAddress(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, '').split('%')[0]!
  const family = isIP(bare)
  if (family === 4) return isPublicV4(ipv4ToNumber(bare))
  if (family !== 6) return false
  const g = ipv6Groups(bare)
  const zeroes = (from: number, to: number) => g.slice(from, to).every((x) => x === 0)
  if (zeroes(0, 5) && g[5] === 0xffff) return isPublicV4(g[6]! * 65536 + g[7]!)
  if (zeroes(0, 7) && (g[7] === 0 || g[7] === 1)) return false
  if ((g[0]! & 0xffc0) === 0xfe80) return false
  if ((g[0]! & 0xfe00) === 0xfc00) return false
  return true
}

/** Why the policy refuses `url`, or null when the import may request it: http(s), to the allowed host or one whose every address is public. */
async function refusal(url: URL, policy: ImagePolicy): Promise<string | null> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    return 'only http and https images are fetched'
  const bare = (hostname: string) => hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const host = bare(url.hostname)
  if (policy.allowHost !== undefined && host === bare(policy.allowHost)) return null
  if (isIP(host) !== 0) return isPublicAddress(host) ? null : `${host} is not a public address`
  const addresses = await (policy.lookup ?? systemLookup)(host)
  if (addresses.length === 0) return `${host} has no address`
  const internal = addresses.find((a) => !isPublicAddress(a))
  return internal === undefined
    ? null
    : `${host} resolves to ${internal}, which is not a public address`
}

/** Why an image was not stored: the source's answer, or the policy's refusal. */
export interface ImageNotStored {
  reason: string
}

/**
 * An image URL as a message names it: scheme, host and path. A user name, password or signed query (an S3 signature)
 * stays out of the report, the state file and the journal.
 */
function displayUrl(src: string): string {
  let url: URL | null = null
  try {
    url = new URL(src)
  } catch {
    // Not a URL: named as written, less anything that could carry a credential.
  }
  if (url !== null && url.host !== '') return `${url.protocol}//${url.host}${url.pathname}`
  return src.replace(/[?#][\s\S]*$/, '').replace(/^[^/]*@/, '')
}

/**
 * Why a lookup or fetch failed, for a merchant: the system error's code (ECONNREFUSED, ENOTFOUND), else its name. Never
 * its message, which can quote the URL whole.
 */
function fetchFailure(error: unknown): string {
  if (error instanceof Error && error.name === 'AbortError') {
    return `no answer within ${TIMEOUT_MS / 1000} s`
  }
  const code = (e: unknown): string | undefined => {
    const value: unknown = e instanceof Error ? (e as Error & { code?: unknown }).code : undefined
    return typeof value === 'string' ? value : undefined
  }
  const cause = error instanceof Error ? error.cause : undefined
  const detail =
    code(error) ??
    code(cause) ??
    (cause instanceof Error ? cause.name : error instanceof Error ? error.name : 'unknown error')
  return `could not be fetched (${detail})`
}

/**
 * The image at `src`, stored. A source the policy refuses (at any redirect hop, of at most three), that cannot be
 * fetched in time, answers non-2xx or is not typed as a supported image is not requested further or stored, and says
 * why; a `put` that rejects is the store's failure, so it is thrown for the caller to report.
 */
export async function downloadImage(
  src: string,
  altText: string,
  storage: MediaStorage,
  subdir: string,
  policy: ImagePolicy = {},
): Promise<DownloadedMedia | ImageNotStored> {
  let body: Uint8Array
  let contentType: string
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    let url: URL
    try {
      url = new URL(src)
    } catch {
      return { reason: 'not a URL' }
    }
    let res: Response
    for (let hop = 0; ; hop++) {
      const refused = await refusal(url, policy)
      if (refused !== null) {
        return {
          reason:
            hop === 0
              ? `refused: ${refused}`
              : `refused after a redirect to ${displayUrl(url.href)}: ${refused}`,
        }
      }
      res = await fetch(url, { signal: controller.signal, redirect: 'manual' })
      const location = res.headers.get('location')
      if (res.status < 300 || res.status >= 400 || location === null) break
      if (hop === MAX_REDIRECTS) return { reason: `more than ${MAX_REDIRECTS} redirects` }
      url = new URL(location, url)
    }
    if (!res.ok) return { reason: `HTTP ${res.status}` }
    contentType = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
    if (SUPPORTED_TYPES[contentType] === undefined) {
      return {
        reason:
          contentType === ''
            ? 'served with no content type'
            : `unsupported type ${contentType} (JPEG, PNG, WebP and GIF are imported)`,
      }
    }
    body = new Uint8Array(await res.arrayBuffer())
  } catch (error) {
    return { reason: fetchFailure(error) }
  } finally {
    clearTimeout(timer)
  }
  const ext = SUPPORTED_TYPES[contentType]!
  const hash = createHash('sha256').update(src).digest('hex').slice(0, 16)
  const key = `${subdir}/${hash}.${ext}`

  const { url } = await storage.put(key, body, contentType)
  return { url, altText: altText || '' }
}

/** A product's images that were not stored, each with its source and why. */
export interface ImageFailure {
  /** The source as `displayUrl` names it. */
  src: string
  reason: string
  /** The media storage refused it: the store's failure, not the source's. */
  byStorage: boolean
}

/** Each image stored, in order, and each one that was not. */
export async function downloadProductImages(
  images: Array<{ src: string; alt: string }>,
  productSlug: string,
  storage: MediaStorage,
  policy: ImagePolicy = {},
): Promise<{ stored: DownloadedMedia[]; failed: ImageFailure[] }> {
  const stored: DownloadedMedia[] = []
  const failed: ImageFailure[] = []
  for (const img of imageSources(images)) {
    try {
      const result = await downloadImage(
        img.src,
        img.alt,
        storage,
        `products/${productSlug}`,
        policy,
      )
      if ('reason' in result) {
        failed.push({ src: displayUrl(img.src), reason: result.reason, byStorage: false })
      } else stored.push(result)
    } catch (error) {
      failed.push({ src: displayUrl(img.src), reason: String(error), byStorage: true })
    }
  }
  return { stored, failed }
}
