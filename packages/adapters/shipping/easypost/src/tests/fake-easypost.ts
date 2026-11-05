import { randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'

// EasyPost's API as the shipping adapter uses it, in process on 127.0.0.1 and port 0. `apiBase` stands for
// https://api.easypost.com/v2/. It serves:
//   POST /v2/shipments              { shipment: { from_address, to_address, parcel } } → 201, the Shipment with rates[]
//   POST /v2/shipments/:id/buy      { rate: { id } } → 200, the Shipment with selected_rate, postage_label, tracking_code
//                                   and tracker; a shipment already bought, or a rate not its own, is a 422
//   GET  /v2/shipments/:id          the Shipment as it stands; 404 for one it never made
//   POST /v2/trackers               { tracker: { tracking_code, carrier? } } → 200, the Tracker; the same code and
//                                   carrier again answer the original Tracker (EasyPost's three-month dedupe)
//   GET  /v2/trackers               { trackers, has_more }
// Every request must carry HTTP Basic with the fake's API key as the user and no password; anything else is a 401.
// Errors are `{ error: { code, message, errors } }`. Shapes follow EasyPost's client library at 3b8b85f
// (EasyPost/easypost-node, its recorded test-mode cassettes Tracker-Service creates-a-tracker and Shipment-Service
// buys-a-shipment) and https://docs.easypost.com/docs/shipments and /trackers, read 2026-11-05.
// Readings it takes without having confirmed them against EasyPost (the live contract run checks them):
//   - a second buy of a bought shipment answers 422 (EasyPost does not document it; the adapter must not rely on the
//     wording or the status beyond "a 4xx");
//   - a rate id of another shipment, bought on this one, answers 422;
//   - the tracker create answers 200 with the original Tracker on a repeat (test mode does not dedupe at all);
//   - GET /v2/trackers?page_size=1 is a cheap authenticated read for health.

export const FAKE_EASYPOST_API_KEY = 'EZTKfake0123456789abcdef'

export type EasyPostRoute =
  | 'shipments.create'
  | 'shipments.buy'
  | 'shipments.get'
  | 'trackers.create'
  | 'trackers.list'

export interface RecordedRequest {
  method: string
  /** The path without the query string: `/v2/shipments/shp_…/buy`. */
  path: string
  route: EasyPostRoute | null
  query: Record<string, string>
  /** The parsed JSON body, or the raw text when it was not JSON, or null when empty. */
  body: unknown
  authorization: string | undefined
  contentType: string | undefined
  status: number
  /** The JSON the fake answered, or undefined for one left hanging. */
  response: unknown
}

/** One Rate as the next shipment offers it: `rate` is EasyPost's decimal string. */
export interface FakeRate {
  carrier?: string
  service?: string
  rate: string
  currency: string
  delivery_days?: number | null
  est_delivery_days?: number | null
}

/** A forced answer: a status and body, or no answer at all. */
export type FakeAnswer = { status: number; body?: unknown } | 'hang'

export interface FakeEasyPost {
  /** What the adapter's `apiBase` is set to: `http://127.0.0.1:<port>/v2/`. */
  readonly apiBase: string
  /** Every request so far, in order, with the status it got (0 for one left hanging). */
  readonly requests: RecordedRequest[]
  /** The rates every shipment made from now on offers; the two default ones after `rates(null)`. */
  rates(rates: FakeRate[] | null): void
  /** From now on `route` (or every route) answers `answer`, until `clear()`. */
  answer(route: EasyPostRoute | 'all', answer: FakeAnswer): void
  clear(): void
  close(): Promise<void>
}

const DEFAULT_RATES: FakeRate[] = [
  {
    carrier: 'USPS',
    service: 'Priority',
    rate: '9.22',
    currency: 'USD',
    delivery_days: 2,
    est_delivery_days: 2,
  },
  {
    carrier: 'USPS',
    service: 'GroundAdvantage',
    rate: '6.40',
    currency: 'USD',
    delivery_days: null,
    est_delivery_days: 5,
  },
]

type Json = Record<string, unknown>

interface Shipment {
  id: string
  rates: Json[]
  selected: Json | null
  label: Json | null
  trackingCode: string | null
  fromAddress: unknown
  toAddress: unknown
  parcel: unknown
}

const hex = (n: number): string => randomBytes(n).toString('hex')
const easypostTime = (): string => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
const fail = (status: number, code: string, message: string) => ({
  status,
  body: { error: { code, message, errors: [] } },
})

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function routeOf(method: string, path: string): { route: EasyPostRoute; id?: string } | null {
  if (method === 'POST' && path === '/v2/shipments') return { route: 'shipments.create' }
  const buy = /^\/v2\/shipments\/([^/]+)\/buy$/.exec(path)
  if (method === 'POST' && buy) return { route: 'shipments.buy', id: decodeURIComponent(buy[1]!) }
  const get = /^\/v2\/shipments\/([^/]+)$/.exec(path)
  if (method === 'GET' && get) return { route: 'shipments.get', id: decodeURIComponent(get[1]!) }
  if (method === 'POST' && path === '/v2/trackers') return { route: 'trackers.create' }
  if (method === 'GET' && path === '/v2/trackers') return { route: 'trackers.list' }
  return null
}

export async function startFakeEasyPost(opts: { apiKey?: string } = {}): Promise<FakeEasyPost> {
  const apiKey = opts.apiKey ?? FAKE_EASYPOST_API_KEY
  const expectedAuth = `Basic ${Buffer.from(`${apiKey}:`, 'utf8').toString('base64')}`
  const requests: RecordedRequest[] = []
  const shipments = new Map<string, Shipment>()
  const trackers = new Map<string, Json>()
  let offered: FakeRate[] = DEFAULT_RATES
  const forced = new Map<EasyPostRoute | 'all', FakeAnswer>()
  const sockets = new Set<Socket>()

  function shipmentJson(s: Shipment): Json {
    return {
      id: s.id,
      object: 'Shipment',
      mode: 'test',
      from_address: s.fromAddress,
      to_address: s.toAddress,
      parcel: s.parcel,
      rates: s.rates,
      selected_rate: s.selected,
      postage_label: s.label,
      tracking_code: s.trackingCode,
      tracker: s.trackingCode === null ? null : (trackers.get(`${s.trackingCode}|`) ?? null),
      created_at: easypostTime(),
      updated_at: easypostTime(),
    }
  }

  function tracker(code: string, carrier: string | null): Json {
    const key = `${code}|${carrier ?? ''}`
    const known = trackers.get(key)
    if (known !== undefined) return known
    const made = {
      id: `trk_${hex(16)}`,
      object: 'Tracker',
      mode: 'test',
      tracking_code: code,
      status: 'pre_transit',
      carrier: carrier ?? 'USPS',
      created_at: easypostTime(),
      updated_at: easypostTime(),
    }
    trackers.set(key, made)
    return made
  }

  function handle(
    matched: { route: EasyPostRoute; id?: string },
    body: unknown,
  ): { status: number; body: unknown } {
    switch (matched.route) {
      case 'shipments.create': {
        const shipment = (body as { shipment?: Json } | null)?.shipment
        const parcel = shipment?.['parcel'] as { weight?: unknown } | undefined
        if (shipment === undefined || typeof parcel?.weight !== 'number' || parcel.weight <= 0) {
          return fail(422, 'PARCEL.WEIGHT.INVALID', 'Parcel weight must be greater than zero.')
        }
        const id = `shp_${hex(16)}`
        const rates = offered.map((r) => ({
          id: `rate_${hex(16)}`,
          object: 'Rate',
          mode: 'test',
          carrier: r.carrier ?? 'USPS',
          service: r.service ?? 'Priority',
          rate: r.rate,
          currency: r.currency,
          delivery_days: r.delivery_days ?? null,
          est_delivery_days: r.est_delivery_days ?? null,
          shipment_id: id,
        }))
        const made: Shipment = {
          id,
          rates,
          selected: null,
          label: null,
          trackingCode: null,
          fromAddress: shipment['from_address'],
          toAddress: shipment['to_address'],
          parcel: { id: `prcl_${hex(16)}`, object: 'Parcel', ...(parcel as Json) },
        }
        shipments.set(id, made)
        return { status: 201, body: shipmentJson(made) }
      }
      case 'shipments.buy': {
        const s = shipments.get(matched.id!)
        if (s === undefined) {
          return fail(404, 'NOT_FOUND', 'The requested resource could not be found.')
        }
        const rateId = (body as { rate?: { id?: unknown } } | null)?.rate?.id
        if (s.selected !== null) {
          return fail(422, 'SHIPMENT.POSTAGE.EXISTS', 'Postage already exists for this shipment.')
        }
        const rate = s.rates.find((r) => r['id'] === rateId)
        if (rate === undefined) {
          return fail(422, 'SHIPMENT.RATE.INVALID', 'The rate does not belong to this shipment.')
        }
        s.selected = rate
        s.trackingCode = `9400100${String(Date.now()).slice(-9)}${hex(3).replace(/\D/g, '7').slice(0, 6)}`
        s.label = {
          id: `pl_${hex(16)}`,
          object: 'PostageLabel',
          label_url: `https://easypost-files.s3.us-west-2.amazonaws.com/files/postage_label/${hex(16)}.png`,
          label_file_type: 'image/png',
        }
        tracker(s.trackingCode, null)
        return { status: 200, body: shipmentJson(s) }
      }
      case 'shipments.get': {
        const s = shipments.get(matched.id!)
        return s === undefined
          ? fail(404, 'NOT_FOUND', 'The requested resource could not be found.')
          : { status: 200, body: shipmentJson(s) }
      }
      case 'trackers.create': {
        const t = (body as { tracker?: { tracking_code?: unknown; carrier?: unknown } } | null)
          ?.tracker
        if (typeof t?.tracking_code !== 'string' || t.tracking_code === '') {
          return fail(422, 'TRACKER.CREATE.ERROR', 'tracking_code is required.')
        }
        const carrier = typeof t.carrier === 'string' ? t.carrier : null
        return { status: 200, body: tracker(t.tracking_code, carrier) }
      }
      case 'trackers.list':
        return {
          status: 200,
          body: { trackers: [...trackers.values()].slice(0, 1), has_more: false },
        }
    }
  }

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const text = await readBody(req)
      const url = new URL(req.url ?? '/', 'http://fake')
      const method = req.method ?? 'GET'
      const matched = routeOf(method, url.pathname)
      let body: unknown = null
      if (text !== '') {
        try {
          body = JSON.parse(text) as unknown
        } catch {
          body = text
        }
      }
      const record: RecordedRequest = {
        method,
        path: url.pathname,
        route: matched?.route ?? null,
        query: Object.fromEntries(url.searchParams),
        body,
        authorization: req.headers.authorization,
        contentType: req.headers['content-type'],
        status: 0,
        response: undefined,
      }
      requests.push(record)
      const force = (matched && forced.get(matched.route)) ?? forced.get('all')
      if (force === 'hang') return
      let answer: { status: number; body?: unknown }
      if (req.headers.authorization !== expectedAuth) {
        answer = fail(401, 'APIKEY.INACTIVE', 'The API key provided is not valid.')
      } else if (force !== undefined) {
        answer = force
      } else if (matched === null) {
        answer = fail(404, 'NOT_FOUND', 'The requested resource could not be found.')
      } else {
        answer = handle(matched, body)
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
    apiBase: `http://127.0.0.1:${port}/v2/`,
    requests,
    rates(rates) {
      offered = rates ?? DEFAULT_RATES
    },
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
  const fake = await startFakeEasyPost()
  await fake.close()
  return fake.apiBase
}
