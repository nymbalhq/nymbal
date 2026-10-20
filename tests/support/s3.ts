import { createHash, createHmac, randomUUID } from 'node:crypto'

// The S3-compatible server (MinIO) the P2-11 media tests use, and a minimal SigV4 client for what the tests do around
// the storage under test: make a bucket of their own with a public-read policy, list it, and remove it. The repository
// carries no S3 SDK outside @nymbalhq/media-s3, which is the subject under test. A missing NYMBAL_TEST_S3_ENDPOINT
// throws, so a suite that needs S3 fails instead of skipping (as tests/support/redis.ts does for Redis).

export const S3_ENDPOINT_VAR = 'NYMBAL_TEST_S3_ENDPOINT'
export const S3_ACCESS_KEY_VAR = 'NYMBAL_TEST_S3_ACCESS_KEY_ID'
export const S3_SECRET_KEY_VAR = 'NYMBAL_TEST_S3_SECRET_ACCESS_KEY'
/** MinIO answers in any region; the tests sign for this one. */
export const S3_TEST_REGION = 'us-east-1'

export interface S3Credentials {
  accessKeyId: string
  secretAccessKey: string
}

/** The server's API URL without a trailing slash, e.g. http://localhost:59000. */
export function s3Endpoint(): string {
  const url = process.env[S3_ENDPOINT_VAR]
  if (url === undefined || url.trim() === '') {
    throw new Error(
      `${S3_ENDPOINT_VAR} is not set: the S3 media suites need an S3-compatible server ` +
        `(docker compose up -d --wait starts MinIO; e.g. ${S3_ENDPOINT_VAR}=http://localhost:59000)`,
    )
  }
  return url.trim().replace(/\/+$/, '')
}

/** MinIO's default root credentials (compose's), unless the environment names others. */
export function s3Credentials(): S3Credentials {
  const nonEmpty = (v: string | undefined) => (v === undefined || v === '' ? undefined : v)
  return {
    accessKeyId: nonEmpty(process.env[S3_ACCESS_KEY_VAR]) ?? 'minioadmin',
    secretAccessKey: nonEmpty(process.env[S3_SECRET_KEY_VAR]) ?? 'minioadmin',
  }
}

const sha256 = (data: string | Uint8Array): string =>
  createHash('sha256').update(data).digest('hex')
const hmac = (key: string | Buffer, data: string): Buffer =>
  createHmac('sha256', key).update(data).digest()

/** RFC 3986 encoding, as SigV4's canonical URI and query want it. */
export const rfc3986 = (s: string): string =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)

interface RequestOptions {
  query?: Record<string, string>
  body?: string | Uint8Array
  contentType?: string
}

/** One SigV4-signed, path-style request: `segments` are the bucket then the key's segments, unencoded. */
async function s3Request(
  method: string,
  segments: string[],
  opts: RequestOptions = {},
): Promise<Response> {
  const endpoint = new URL(s3Endpoint())
  const { accessKeyId, secretAccessKey } = s3Credentials()
  const canonicalUri = endpoint.pathname.replace(/\/+$/, '') + '/' + segments.map(rfc3986).join('/')
  const query = Object.entries(opts.query ?? {})
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${rfc3986(k)}=${rfc3986(v)}`)
    .join('&')
  const body =
    opts.body === undefined
      ? new Uint8Array(0)
      : typeof opts.body === 'string'
        ? new TextEncoder().encode(opts.body)
        : opts.body
  const payloadHash = sha256(body)
  const amzDate = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '')
  const day = amzDate.slice(0, 8)
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date'
  const canonicalHeaders = `host:${endpoint.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`
  const canonicalRequest = [
    method,
    canonicalUri,
    query,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n')
  const scope = `${day}/${S3_TEST_REGION}/s3/aws4_request`
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n')
  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${secretAccessKey}`, day), S3_TEST_REGION), 's3'),
    'aws4_request',
  )
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex')
  return fetch(`${endpoint.origin}${canonicalUri}${query === '' ? '' : `?${query}`}`, {
    method,
    headers: {
      authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      ...(opts.contentType !== undefined && { 'content-type': opts.contentType }),
    },
    ...(body.length > 0 && { body: new Uint8Array(body) }),
  })
}

async function expectOk(res: Response, what: string): Promise<string> {
  const text = await res.text()
  if (!res.ok) throw new Error(`${what} answered ${res.status}: ${text.slice(0, 500)}`)
  return text
}

const XML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
}
const unescapeXml = (s: string): string =>
  s.replace(/&(amp|lt|gt|quot|apos);/g, (e) => XML_ENTITIES[e] ?? e)

/** A bucket this run made, with anonymous download on its objects. */
export interface TestBucket {
  name: string
  endpoint: string
  region: string
  credentials: S3Credentials
  /** Where path-style URLs of its objects start: `${endpoint}/${name}`. */
  url: string
  /** Every object key in the bucket. */
  keys(): Promise<string[]>
  /** Deletes every object, then the bucket. */
  remove(): Promise<void>
}

/** A bucket name no other run has used: `nymbal-test-<stamp>-<label>-<random>`, within S3's naming rules. */
export function uniqueBucketName(label: string): string {
  const safe = label
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .slice(0, 16)
  return `nymbal-test-${Date.now().toString(36)}-${safe}-${randomUUID().slice(0, 6)}`
}

/** Creates `name` (default: a fresh unique name) with a public-read policy: anyone may GET or HEAD its objects. */
export async function createPublicBucket(
  label: string,
  name = uniqueBucketName(label),
): Promise<TestBucket> {
  const endpoint = s3Endpoint()
  await expectOk(await s3Request('PUT', [name]), `CreateBucket ${name}`)
  const policy = {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Principal: { AWS: ['*'] },
        Action: ['s3:GetObject'],
        Resource: [`arn:aws:s3:::${name}/*`],
      },
    ],
  }
  await expectOk(
    await s3Request('PUT', [name], {
      query: { policy: '' },
      body: JSON.stringify(policy),
      contentType: 'application/json',
    }),
    `PutBucketPolicy ${name}`,
  )

  const keys = async (): Promise<string[]> => {
    const out: string[] = []
    let token: string | undefined
    do {
      const xml = await expectOk(
        await s3Request('GET', [name], {
          query: { 'list-type': '2', ...(token !== undefined && { 'continuation-token': token }) },
        }),
        `ListObjectsV2 ${name}`,
      )
      for (const m of xml.matchAll(/<Key>([\s\S]*?)<\/Key>/g)) out.push(unescapeXml(m[1]!))
      const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml)
      const next = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1]
      token = truncated && next !== undefined ? unescapeXml(next) : undefined
    } while (token !== undefined)
    return out
  }

  return {
    name,
    endpoint,
    region: S3_TEST_REGION,
    credentials: s3Credentials(),
    url: `${endpoint}/${name}`,
    keys,
    async remove() {
      for (const key of await keys()) {
        await expectOk(await s3Request('DELETE', [name, ...key.split('/')]), `DeleteObject ${key}`)
      }
      await expectOk(await s3Request('DELETE', [name]), `DeleteBucket ${name}`)
    },
  }
}

/** What an anonymous GET (no credentials) of `url` answers. */
export async function anonymousGet(
  url: string,
): Promise<{ status: number; bytes: Uint8Array; contentType: string | null }> {
  const res = await fetch(url)
  return {
    status: res.status,
    bytes: new Uint8Array(await res.arrayBuffer()),
    contentType: res.headers.get('content-type'),
  }
}
