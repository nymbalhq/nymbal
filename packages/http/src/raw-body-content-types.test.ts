import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { securitySchema } from '@nymbalhq/config'
import type { RequestContext } from '@nymbalhq/types'
import { FastifyHttpAdapter } from './fastify-adapter.js'

// A provider signs the exact bytes it sends, in whatever encoding it posts: a route registered with `rawBody` gets
// those bytes for every content type, while every other route takes the content types it took before.

const logger = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return this
  },
}

const RAW = '/raw'
const PLAIN = '/plain'
const INVALID_MEDIA_TYPE = 'FST_ERR_CTP_INVALID_MEDIA_TYPE'

/** What a handler saw: its raw bytes (base64, or null), and its body as text, or its parse. */
interface Seen {
  raw: string | null
  text: string | null
  parsed: unknown
}

const ran = { [RAW]: 0, [PLAIN]: 0 }

function echo(route: keyof typeof ran) {
  return (ctx: RequestContext) => {
    ran[route] += 1
    const seen: Seen = {
      raw: ctx.rawBody === undefined ? null : ctx.rawBody.toString('base64'),
      text: typeof ctx.body === 'string' ? ctx.body : null,
      parsed: typeof ctx.body === 'string' ? null : (ctx.body ?? null),
    }
    return { status: 200, body: seen }
  }
}

let adapter: FastifyHttpAdapter
let base = ''

beforeAll(async () => {
  adapter = new FastifyHttpAdapter({
    logger,
    security: securitySchema.parse({ adapter: 'middleware' }),
  })
  adapter.registerRoute('POST', RAW, echo(RAW), { csrf: false, rawBody: true })
  adapter.registerRoute('POST', PLAIN, echo(PLAIN), { csrf: false })
  await adapter.start(0, '127.0.0.1')
  base = `http://127.0.0.1:${adapter.boundPort}`
})

afterAll(async () => {
  await adapter?.stop()
})

interface Answer {
  status: number
  text: string
  seen: Seen | null
}

/** `bytes` posted as they are; `contentType` null sends no Content-Type header at all. */
async function post(path: string, bytes: Buffer, contentType: string | null): Promise<Answer> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: contentType === null ? {} : { 'content-type': contentType },
    body: new Uint8Array(bytes),
  })
  const text = await res.text()
  let seen: Seen | null = null
  if (res.status === 200) seen = JSON.parse(text) as Seen
  return { status: res.status, text, seen }
}

const rawOf = (a: Answer): Buffer | null =>
  a.seen?.raw == null ? null : Buffer.from(a.seen.raw, 'base64')

const utf8 = (s: string): Buffer => Buffer.from(s, 'utf8')

// ─── Generated bodies ─────────────────────────────────────────────────────────────────────────────────────────────

/** A form body, canonical (URLSearchParams) or as a provider might write it: `%20` and `+`, repeated keys, raw `~`. */
const formBody = fc.oneof(
  fc
    .array(fc.tuple(fc.string({ maxLength: 12 }), fc.string({ maxLength: 24 })), {
      minLength: 1,
      maxLength: 5,
    })
    .map((pairs) => utf8(new URLSearchParams(pairs).toString())),
  fc
    .stringMatching(
      /^[a-z0-9_.~*%+-]{1,10}=[a-zA-Z0-9_.~*%+-]{0,20}(&[a-z]{1,6}=[a-z%+0-9]{0,8}){0,3}$/,
    )
    .map(utf8),
)

const textBody = fc.string({ unit: 'grapheme', minLength: 1, maxLength: 200 }).map(utf8)

const multipart = fc
  .record({
    boundary: fc.stringMatching(/^[A-Za-z0-9]{12,30}$/),
    parts: fc.array(
      fc.record({
        name: fc.stringMatching(/^[a-z]{1,8}$/),
        value: fc.uint8Array({ maxLength: 64 }),
      }),
      { minLength: 1, maxLength: 3 },
    ),
  })
  .map(({ boundary, parts }) => ({
    contentType: `multipart/form-data; boundary=${boundary}`,
    bytes: Buffer.concat([
      ...parts.flatMap((p) => [
        utf8(`--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"\r\n\r\n`),
        Buffer.from(p.value),
        utf8('\r\n'),
      ]),
      utf8(`--${boundary}--\r\n`),
    ]),
  }))

const octets = fc.uint8Array({ minLength: 1, maxLength: 512 }).map((a) => Buffer.from(a))

/** A body and the content type it is sent as, for every type but JSON. */
const nonJson = fc.oneof(
  formBody.map((bytes) => ({ contentType: 'application/x-www-form-urlencoded', bytes })),
  textBody.map((bytes) => ({ contentType: 'text/plain; charset=utf-8', bytes })),
  multipart,
  octets.map((bytes) => ({ contentType: 'application/octet-stream', bytes })),
)

/** A JSON object, written with generated indentation, so bytes re-serialised from its parse would differ. */
const jsonBody = fc
  .record({
    value: fc.dictionary(fc.stringMatching(/^[a-z]{1,6}$/), fc.jsonValue({ maxDepth: 2 }), {
      minKeys: 1,
      maxKeys: 4,
    }),
    indent: fc.integer({ min: 0, max: 4 }),
  })
  .map(({ value, indent }) => JSON.stringify(value, null, indent))
  .filter((text) => !text.includes('"__proto__"') && !text.includes('"constructor"'))
  .map(utf8)

describe('raw request bodies for every content type, on rawBody routes only', () => {
  it('AC-1: property: a rawBody route gets ctx.rawBody byte-equal to what was sent, and ctx.body as its UTF-8 text, for form-encoded, text/plain, multipart and octet-stream bodies', async () => {
    await fc.assert(
      fc.asyncProperty(nonJson, async ({ contentType, bytes }) => {
        const answer = await post(RAW, bytes, contentType)
        const label = `${contentType}: ${answer.status} ${answer.text.slice(0, 200)}`

        expect(answer.status, label).toBe(200)
        expect(rawOf(answer)?.equals(bytes), label).toBe(true)
        expect(answer.seen?.text, label).toBe(bytes.toString('utf8'))
      }),
      { numRuns: 60 },
    )
  })

  it('AC-1: property: JSON on a rawBody route keeps its bytes and its parse; malformed JSON answers 400 and a __proto__ body is refused, neither reaching the handler, while the same malformed bytes sent as text/plain reach it byte for byte', async () => {
    await fc.assert(
      fc.asyncProperty(jsonBody, async (bytes) => {
        const answer = await post(RAW, bytes, 'application/json')

        expect(answer.status, answer.text).toBe(200)
        expect(rawOf(answer)?.equals(bytes)).toBe(true)
        expect(JSON.stringify(answer.seen?.parsed)).toBe(
          JSON.stringify(JSON.parse(bytes.toString('utf8'))),
        )
      }),
      { numRuns: 30 },
    )

    const malformed = utf8('{"recipient": "a@x.test", ')
    const poisoned = utf8('{"__proto__": {"admin": true}}')
    const before = ran[RAW]

    const refused = [
      await post(RAW, malformed, 'application/json'),
      await post(RAW, poisoned, 'application/json'),
    ]
    expect(refused.map((a) => a.status)).toEqual([400, 400])
    expect(ran[RAW]).toBe(before)

    const asText = await post(RAW, malformed, 'text/plain')
    expect(asText.status, asText.text).toBe(200)
    expect(rawOf(asText)?.equals(malformed)).toBe(true)
    expect(ran[RAW]).toBe(before + 1)
  })

  it('AC-2: a route without rawBody answers 415 FST_ERR_CTP_INVALID_MEDIA_TYPE to form-encoded, octet-stream and untyped bodies without running its handler, and sees no rawBody for text or JSON, while the rawBody route gets the same bytes', async () => {
    const form = utf8('id=dlv_1&type=bounce&recipient=a%40x.test')
    const octet = Buffer.from([0x00, 0xff, 0x10, 0x80, 0x7f])
    const untyped = utf8('recipient=a@x.test')
    const text = utf8('a bounce, as text: ✉')
    const json = utf8('{"recipient":"a@x.test"}')
    const refusedTypes: Array<[Buffer, string | null]> = [
      [form, 'application/x-www-form-urlencoded'],
      [octet, 'application/octet-stream'],
      [untyped, null],
    ]
    const plainBefore = ran[PLAIN]

    const plain = await Promise.all(refusedTypes.map(([bytes, type]) => post(PLAIN, bytes, type)))

    expect(plain.map((a) => a.status)).toEqual(refusedTypes.map(() => 415))
    expect(plain.filter((a) => !a.text.includes(INVALID_MEDIA_TYPE)).map((a) => a.text)).toEqual([])
    expect(ran[PLAIN]).toBe(plainBefore)

    const plainText = await post(PLAIN, text, 'text/plain; charset=utf-8')
    const plainJson = await post(PLAIN, json, 'application/json')
    expect([plainText.status, plainText.seen?.text, plainText.seen?.raw]).toEqual([
      200,
      text.toString('utf8'),
      null,
    ])
    expect([plainJson.status, plainJson.seen?.parsed, plainJson.seen?.raw]).toEqual([
      200,
      JSON.parse(json.toString('utf8')),
      null,
    ])
    expect(ran[PLAIN]).toBe(plainBefore + 2)

    const raw = await Promise.all(
      [...refusedTypes, [text, 'text/plain; charset=utf-8'] as [Buffer, string]].map(
        ([bytes, type]) => post(RAW, bytes, type),
      ),
    )
    expect(raw.map((a) => a.status)).toEqual(raw.map(() => 200))
    expect(raw.map((a) => rawOf(a)?.toString('base64') ?? null)).toEqual(
      [...refusedTypes.map(([bytes]) => bytes), text].map((bytes) => bytes.toString('base64')),
    )
  })
})
