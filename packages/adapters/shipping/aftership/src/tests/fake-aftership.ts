import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'

// AfterShip Tracking's API (version 2026-07) as the shipping adapter uses it, in process on 127.0.0.1 and port 0.
// `apiBase` stands for https://api.aftership.com. It serves:
//   POST /tracking/2026-07/trackings   a flat { tracking_number, slug?, … } → 201 { meta, data: Tracking }; the same
//                                      number and slug again → 400 meta 4003 TRACKING_ALREADY_EXIST
//   GET  /tracking/2026-07/couriers    200 { meta, data: { total, couriers } }
// Every request must carry `as-api-key` with the fake's key; anything else is 401 meta 401. Every answer is
// `{ meta: { code, message, type }, data }`. Shapes and meta codes follow the official SDK, AfterShip/tracking-sdk-
// nodejs branch 2026-07 at f3ec2eb (src/api/Tracking.ts:45-56, src/model/CreateTrackingRequest.ts, src/lib/request.ts,
// src/error/meta_code.ts: 4003 exists, 4005 invalid number, 4010 invalid slug, 4012 bad courier, 401 key, 429 rate).
// Readings it takes without having confirmed them against AfterShip (the live contract run checks them):
//   - a create answers 201 (the SDK accepts any 2xx);
//   - a repeat is matched on number and slug, and answers HTTP 400 with meta 4003;
//   - GET couriers is a cheap authenticated read for health.

export const FAKE_AFTERSHIP_API_KEY = 'asat_fake_0123456789abcdef'

export const TRACKINGS_PATH = '/tracking/2026-07/trackings'
export const COURIERS_PATH = '/tracking/2026-07/couriers'

export type AfterShipRoute = 'trackings.create' | 'couriers.list'

export interface RecordedRequest {
  method: string
  path: string
  route: AfterShipRoute | null
  body: unknown
  apiKey: string | undefined
  contentType: string | undefined
  status: number
  response: unknown
}

/** A forced answer: a status and body, or no answer at all. */
export type FakeAnswer = { status: number; body?: unknown } | 'hang'

/** AfterShip's error body for `status` and meta `code`. */
export function metaError(status: number, code: number, type: string, message: string): FakeAnswer {
  return { status, body: { meta: { code, type, message }, data: {} } }
}

/** The refusals the adapter must take as permanent, as AfterShip writes them. */
export const REFUSALS: Record<'4005' | '4010' | '4012', FakeAnswer> = {
  '4005': metaError(400, 4005, 'BadRequest', 'The value of `tracking_number` is invalid.'),
  '4010': metaError(400, 4010, 'BadRequest', 'The value of `slug` is invalid.'),
  '4012': metaError(
    400,
    4012,
    'BadRequest',
    'Cannot detect courier. Activate courier at https://admin.aftership.com/settings/couriers.',
  ),
}

export interface FakeAfterShip {
  /** What the adapter's `apiBase` is set to: `http://127.0.0.1:<port>`. */
  readonly apiBase: string
  readonly requests: RecordedRequest[]
  /** From now on `route` (or every route) answers `answer`, until `clear()`. */
  answer(route: AfterShipRoute | 'all', answer: FakeAnswer): void
  clear(): void
  close(): Promise<void>
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function routeOf(method: string, path: string): AfterShipRoute | null {
  if (method === 'POST' && path === TRACKINGS_PATH) return 'trackings.create'
  if (method === 'GET' && path === COURIERS_PATH) return 'couriers.list'
  return null
}

export async function startFakeAfterShip(opts: { apiKey?: string } = {}): Promise<FakeAfterShip> {
  const apiKey = opts.apiKey ?? FAKE_AFTERSHIP_API_KEY
  const requests: RecordedRequest[] = []
  const trackings = new Map<string, Record<string, unknown>>()
  const forced = new Map<AfterShipRoute | 'all', FakeAnswer>()
  const sockets = new Set<Socket>()

  function handle(route: AfterShipRoute, body: unknown): { status: number; body: unknown } {
    if (route === 'couriers.list') {
      return {
        status: 200,
        body: {
          meta: { code: 200, message: '', type: 'OK' },
          data: { total: 1, couriers: [{ slug: 'usps', name: 'USPS' }] },
        },
      }
    }
    const given = (body ?? {}) as { tracking_number?: unknown; slug?: unknown }
    if (typeof given.tracking_number !== 'string' || given.tracking_number === '') {
      return REFUSALS['4005'] as { status: number; body: unknown }
    }
    const slug = typeof given.slug === 'string' ? given.slug : null
    const key = `${given.tracking_number}|${slug ?? ''}`
    const known = trackings.get(key)
    if (known !== undefined) {
      return {
        status: 400,
        body: {
          meta: { code: 4003, type: 'BadRequest', message: 'Tracking already exists.' },
          data: {
            tracking: {
              id: known['id'],
              slug: known['slug'],
              tracking_number: known['tracking_number'],
            },
          },
        },
      }
    }
    const made = {
      id: randomBytes(12).toString('hex'),
      tracking_number: given.tracking_number,
      slug: slug ?? 'usps',
      tag: 'Pending',
      subtag: 'Pending_001',
      created_at: new Date().toISOString(),
    }
    trackings.set(key, made)
    return { status: 201, body: { meta: { code: 201, message: '', type: 'Created' }, data: made } }
  }

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const text = await readBody(req)
      const url = new URL(req.url ?? '/', 'http://fake')
      const method = req.method ?? 'GET'
      const route = routeOf(method, url.pathname)
      let body: unknown = null
      if (text !== '') {
        try {
          body = JSON.parse(text) as unknown
        } catch {
          body = text
        }
      }
      const header = req.headers['as-api-key']
      const record: RecordedRequest = {
        method,
        path: url.pathname,
        route,
        body,
        apiKey: Array.isArray(header) ? header[0] : header,
        contentType: req.headers['content-type'],
        status: 0,
        response: undefined,
      }
      requests.push(record)
      const force = (route && forced.get(route)) ?? forced.get('all')
      if (force === 'hang') return
      let answer: { status: number; body?: unknown }
      if (record.apiKey !== apiKey) {
        answer = metaError(401, 401, 'Unauthorized', 'Invalid API key.') as {
          status: number
          body: unknown
        }
      } else if (force !== undefined) {
        answer = force
      } else if (route === null) {
        answer = metaError(404, 404, 'NotFound', 'The URI requested is invalid.') as {
          status: number
          body: unknown
        }
      } else {
        answer = handle(route, body)
      }
      record.status = answer.status
      record.response = answer.body
      res.writeHead(answer.status, { 'content-type': 'application/json' })
      res.end(answer.body === undefined ? '' : JSON.stringify(answer.body))
    })()
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo

  return {
    apiBase: `http://127.0.0.1:${port}`,
    requests,
    answer(route, answer) {
      forced.set(route, answer)
    },
    clear() {
      forced.clear()
    },
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

/** An `apiBase` nothing listens on: a fake started and closed again. */
export async function closedApiBase(): Promise<string> {
  const fake = await startFakeAfterShip()
  await fake.close()
  return fake.apiBase
}
