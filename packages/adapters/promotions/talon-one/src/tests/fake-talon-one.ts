import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo, Socket } from 'node:net'

// Talon.One's Integration API as the promotions adapter uses it, in process on 127.0.0.1 and port 0. `baseUrl` stands
// for https://<deployment>.talon.one. It serves one endpoint:
//   PUT /v2/customer_sessions/:id[?dry=true]
//     body { customerSession: { profileId?, state?, couponCodes?, cartItems? }, responseContent? }
//     → 200 { customerSession, effects, coupons? (when responseContent holds 'coupons'), createdCoupons: [] }
//   With dry=true the session is evaluated and nothing is saved. Without it the session is saved by id with its state,
//   items and codes. `state` moves open → closed, open → cancelled, closed → cancelled; any other move is a 400.
// Every request must carry `Authorization: ApiKey-v1 <the fake's key>`; anything else is a 401. A cart item needs a
// `sku` of at least one character, a whole `quantity` of at least 1 and a `price` (a decimal in major units) of 0 or
// more; anything else is a 400. Shapes follow https://docs.talon.one/oas/integration.yaml and the effects page,
// https://docs.talon.one/docs/dev/integration-api/api-effects, read 2026-11-22.
// Effects: an accepted coupon answers `acceptCoupon` { value: the coupon's own spelling } and its discount with
// `triggeredByCoupon` set to the coupon's id; an unknown, expired or used-up one answers `rejectCoupon` { value: the
// code as sent, rejectionReason }. A discount is `setDiscount` { name, value } on the cart, or, per item, one
// `setDiscountPerItem` { name, value, position, subPosition } for each unit (cart item flattening). Values are in major
// units and keep their fractions.
// Readings it takes without having confirmed them against Talon.One (the live contract run checks them):
//   - a PUT with only `state` keeps the saved items and codes, and its answer holds the session's effects again;
//   - closed → closed without an idempotency key is a 4xx (400 here);
//   - a coupon's use is counted when a session holding it closes, never while it is open, and given back when a
//     closed session is cancelled; a cancelled open session gives nothing back;
//   - a limit reached at close answers `rejectCoupon` (CouponLimitReached) for that coupon, and the close stands;
//   - a repeated `Idempotency-Key` replays the first answer, status and body, and changes nothing;
//   - a request that failed (the outage and 5xx answers forced here, or a 401) stores nothing under its
//     `Idempotency-Key`, so its retry is evaluated afresh; the OpenAPI file says only that responses to idempotent
//     requests are stored and expire after 24 hours;
//   - coupon codes match without case.

export const FAKE_TALON_ONE_API_KEY = 'talon-fake-key-5c1e9a7d3b'

export type SessionState = 'open' | 'closed' | 'cancelled'

/** A coupon the fake knows: `percent` off, or `amount` (major units) off, the cart or each unit. */
export interface FakeCoupon {
  code: string
  percent?: number
  amount?: number
  perItem?: boolean
  /** How many closed sessions may use it. */
  limit?: number
  expired?: boolean
}

/** A campaign that needs no code: it applies to every session. */
export interface FakeCampaign {
  name: string
  percent?: number
  amount?: number
  perItem?: boolean
}

export interface FakeCartItem {
  sku: string
  quantity: number
  price: number
}

export interface SavedSession {
  id: string
  state: SessionState
  profileId?: string
  couponCodes: string[]
  cartItems: FakeCartItem[]
  /** How many times each state was set on the session, by a request that changed something. */
  stateSets: Record<SessionState, number>
  /** The codes whose use this session's close counted. */
  counted: string[]
}

export interface RecordedRequest {
  method: string
  /** The path without the query string: `/v2/customer_sessions/<id>`. */
  path: string
  /** The session id from the path, decoded; null for any other path. */
  sessionId: string | null
  query: Record<string, string>
  /** The parsed JSON body, or the raw text when it was not JSON, or null when empty. */
  body: unknown
  authorization: string | undefined
  idempotencyKey: string | undefined
  contentType: string | undefined
  /** The status answered, 0 for one left hanging. */
  status: number
  /** The JSON the fake answered, or undefined for one left hanging. */
  response: unknown
}

/** A forced answer: a status with a JSON body, or with raw text, or no answer at all. */
export type FakeAnswer = { status: number; body?: unknown; raw?: string } | 'hang'

export interface FakeTalonOne {
  /** What the adapter's `baseUrl` is set to: `http://127.0.0.1:<port>`, no trailing slash. */
  readonly baseUrl: string
  /** Every request so far, in order. */
  readonly requests: RecordedRequest[]
  /** The saved sessions by id. */
  readonly sessions: ReadonlyMap<string, SavedSession>
  /** The coupons known from now on (replacing any before). */
  coupons(list: FakeCoupon[]): void
  /** The code-less campaigns running from now on (replacing any before). */
  campaigns(list: FakeCampaign[]): void
  /** How many closed sessions have used the code. */
  uses(code: string): number
  /** From now on every authorised request answers `answer`, until `answer(null)`. */
  answer(answer: FakeAnswer | null): void
  close(): Promise<void>
}

type Json = Record<string, unknown>

interface Answer {
  status: number
  body?: unknown
  raw?: string
}

interface Effect {
  campaignId: number
  rulesetId: number
  ruleIndex: number
  ruleName: string
  effectType: string
  triggeredByCoupon?: number
  props: Json
}

const fail = (status: number, message: string): Answer => ({
  status,
  body: { message, errors: [{ title: message }], StatusCode: status },
})

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

const MOVES: Record<SessionState, readonly SessionState[]> = {
  open: ['open', 'closed', 'cancelled'],
  closed: ['cancelled'],
  cancelled: [],
}

function validItems(items: unknown): items is FakeCartItem[] {
  return (
    Array.isArray(items) &&
    items.every(
      (i: unknown) =>
        typeof i === 'object' &&
        i !== null &&
        typeof (i as Json)['sku'] === 'string' &&
        ((i as Json)['sku'] as string).length >= 1 &&
        Number.isInteger((i as Json)['quantity']) &&
        ((i as Json)['quantity'] as number) >= 1 &&
        typeof (i as Json)['price'] === 'number' &&
        ((i as Json)['price'] as number) >= 0,
    )
  )
}

export async function startFakeTalonOne(
  opts: { apiKey?: string; coupons?: FakeCoupon[]; campaigns?: FakeCampaign[] } = {},
): Promise<FakeTalonOne> {
  const expectedAuth = `ApiKey-v1 ${opts.apiKey ?? FAKE_TALON_ONE_API_KEY}`
  const requests: RecordedRequest[] = []
  const sessions = new Map<string, SavedSession>()
  const replays = new Map<string, Answer>()
  const usage = new Map<string, number>()
  let coupons: FakeCoupon[] = opts.coupons ?? []
  let campaigns: FakeCampaign[] = opts.campaigns ?? []
  let forced: FakeAnswer | null = null
  const sockets = new Set<Socket>()

  const couponOf = (code: string) => {
    const index = coupons.findIndex((c) => c.code.toLowerCase() === code.toLowerCase())
    return index === -1 ? undefined : { coupon: coupons[index]!, id: 500 + index, index }
  }
  const usesOf = (code: string) => usage.get(code.toLowerCase()) ?? 0

  function discounts(
    rule: { name: string; percent?: number; amount?: number; perItem?: boolean },
    items: FakeCartItem[],
    base: Omit<Effect, 'effectType' | 'props'>,
  ): Effect[] {
    const subtotal = items.reduce((sum, i) => sum + i.price * i.quantity, 0)
    if (rule.perItem === true) {
      return items.flatMap((item, position) =>
        Array.from({ length: item.quantity }, (_, subPosition) => ({
          ...base,
          effectType: 'setDiscountPerItem',
          props: {
            name: rule.name,
            value:
              rule.percent !== undefined
                ? (item.price * rule.percent) / 100
                : Math.min(rule.amount ?? 0, item.price),
            position,
            subPosition,
          },
        })),
      )
    }
    return [
      {
        ...base,
        effectType: 'setDiscount',
        props: {
          name: rule.name,
          value:
            rule.percent !== undefined
              ? (subtotal * rule.percent) / 100
              : Math.min(rule.amount ?? 0, subtotal),
        },
      },
    ]
  }

  /** The effects a session's items and codes earn; at close each used coupon is counted, or refused at its limit. */
  function evaluate(
    codes: readonly string[],
    items: FakeCartItem[],
    phase: 'evaluate' | 'close',
  ): { effects: Effect[]; coupons: Json[]; counted: string[] } {
    const effects: Effect[] = []
    const out: Json[] = []
    const counted: string[] = []
    const reject = (code: string, reason: string, campaignId = 0) =>
      effects.push({
        campaignId,
        rulesetId: 0,
        ruleIndex: 0,
        ruleName: '',
        effectType: 'rejectCoupon',
        props: { value: code, rejectionReason: reason },
      })
    for (const code of codes) {
      const found = couponOf(code)
      if (found === undefined) {
        reject(code, 'CouponNotFound')
        continue
      }
      const { coupon, id, index } = found
      const campaignId = 1000 + index
      if (coupon.expired === true) {
        reject(code, 'CouponExpired', campaignId)
        continue
      }
      if (coupon.limit !== undefined && usesOf(coupon.code) >= coupon.limit) {
        reject(code, 'CouponLimitReached', campaignId)
        continue
      }
      if (phase === 'close') {
        usage.set(coupon.code.toLowerCase(), usesOf(coupon.code) + 1)
        counted.push(coupon.code)
      }
      out.push({ id, value: coupon.code, campaignId, usageCounter: usesOf(coupon.code) })
      const base = {
        campaignId,
        rulesetId: campaignId,
        ruleIndex: 0,
        ruleName: coupon.code,
        triggeredByCoupon: id,
      }
      effects.push({ ...base, effectType: 'acceptCoupon', props: { value: coupon.code } })
      effects.push(...discounts({ ...coupon, name: `Coupon ${coupon.code}` }, items, base))
    }
    campaigns.forEach((campaign, index) => {
      const campaignId = 2000 + index
      effects.push(
        ...discounts(campaign, items, {
          campaignId,
          rulesetId: campaignId,
          ruleIndex: 0,
          ruleName: campaign.name,
        }),
      )
    })
    return { effects, coupons: out, counted }
  }

  function handle(id: string, query: Record<string, string>, body: unknown): Answer {
    const cs = (body as { customerSession?: Json } | null)?.customerSession
    if (typeof cs !== 'object' || cs === null) return fail(400, 'customerSession is required')
    const responseContent = (body as { responseContent?: unknown }).responseContent
    const wantsCoupons = Array.isArray(responseContent) && responseContent.includes('coupons')
    const existing = sessions.get(id)
    const state = (cs['state'] ?? 'open') as SessionState
    if (!['open', 'closed', 'cancelled'].includes(state)) return fail(400, `unknown state ${state}`)
    const items = cs['cartItems'] ?? existing?.cartItems ?? []
    if (!validItems(items)) return fail(400, 'a cart item needs sku, quantity and price')
    const codes = cs['couponCodes'] ?? existing?.couponCodes ?? []
    if (!Array.isArray(codes) || !codes.every((c) => typeof c === 'string')) {
      return fail(400, 'couponCodes must be strings')
    }
    const profileId = typeof cs['profileId'] === 'string' ? cs['profileId'] : existing?.profileId
    const dry = query['dry'] === 'true'

    const answer = (session: Json, evaluated: { effects: Effect[]; coupons: Json[] }): Answer => ({
      status: 200,
      body: {
        customerSession: session,
        effects: evaluated.effects,
        ...(wantsCoupons && { coupons: evaluated.coupons }),
        createdCoupons: [],
        createdReferrals: [],
      },
    })
    const sessionJson = (s: {
      state: SessionState
      couponCodes: string[]
      cartItems: FakeCartItem[]
      profileId?: string
    }) => ({
      integrationId: id,
      state: s.state,
      couponCodes: s.couponCodes,
      cartItems: s.cartItems,
      ...(s.profileId !== undefined && { profileId: s.profileId }),
    })

    if (dry) {
      const evaluated = evaluate(codes as string[], items, 'evaluate')
      return answer(
        sessionJson({
          state,
          couponCodes: codes as string[],
          cartItems: items,
          ...(profileId !== undefined && { profileId }),
        }),
        evaluated,
      )
    }

    if (existing !== undefined && !MOVES[existing.state].includes(state)) {
      return fail(400, `the customer session is ${existing.state} and cannot become ${state}`)
    }
    const saved: SavedSession = existing ?? {
      id,
      state,
      couponCodes: [],
      cartItems: [],
      stateSets: { open: 0, closed: 0, cancelled: 0 },
      counted: [],
    }
    saved.couponCodes = codes as string[]
    saved.cartItems = items
    if (profileId !== undefined) saved.profileId = profileId
    const before = existing?.state
    saved.state = state
    saved.stateSets[state] += 1
    sessions.set(id, saved)

    let evaluated: { effects: Effect[]; coupons: Json[] }
    if (state === 'closed') {
      const closing = evaluate(saved.couponCodes, saved.cartItems, 'close')
      saved.counted = closing.counted
      evaluated = closing
    } else if (state === 'cancelled') {
      if (before === 'closed') {
        for (const code of saved.counted) {
          usage.set(code.toLowerCase(), Math.max(0, usesOf(code) - 1))
        }
        saved.counted = []
      }
      evaluated = { effects: [], coupons: [] }
    } else {
      evaluated = evaluate(saved.couponCodes, saved.cartItems, 'evaluate')
    }
    return answer(sessionJson(saved), evaluated)
  }

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const text = await readBody(req)
      const url = new URL(req.url ?? '/', 'http://fake')
      const method = req.method ?? 'GET'
      const match = /^\/v2\/customer_sessions\/([^/]+)$/.exec(url.pathname)
      const sessionId = match ? decodeURIComponent(match[1]!) : null
      let body: unknown = null
      if (text !== '') {
        try {
          body = JSON.parse(text) as unknown
        } catch {
          body = text
        }
      }
      const key = req.headers['idempotency-key']
      const idempotencyKey = Array.isArray(key) ? key[0] : key
      const record: RecordedRequest = {
        method,
        path: url.pathname,
        sessionId,
        query: Object.fromEntries(url.searchParams),
        body,
        authorization: req.headers.authorization,
        idempotencyKey,
        contentType: req.headers['content-type'],
        status: 0,
        response: undefined,
      }
      requests.push(record)
      if (forced === 'hang' && req.headers.authorization === expectedAuth) return
      let answer: Answer
      if (req.headers.authorization !== expectedAuth) {
        answer = fail(401, 'Unauthorized: the API key is not valid')
      } else if (forced !== null && forced !== 'hang') {
        answer = forced
      } else if (method !== 'PUT' || sessionId === null) {
        answer = fail(404, 'Not found')
      } else if (idempotencyKey !== undefined && replays.has(idempotencyKey)) {
        answer = replays.get(idempotencyKey)!
      } else {
        answer = handle(sessionId, record.query, body)
        if (idempotencyKey !== undefined) replays.set(idempotencyKey, answer)
      }
      record.status = answer.status
      record.response = answer.raw ?? answer.body
      res.writeHead(answer.status, {
        'content-type': answer.raw !== undefined ? 'text/html' : 'application/json',
      })
      res.end(
        answer.raw !== undefined
          ? answer.raw
          : answer.body === undefined
            ? ''
            : JSON.stringify(answer.body),
      )
    })()
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    requests,
    sessions,
    coupons(list) {
      coupons = list
    },
    campaigns(list) {
      campaigns = list
    },
    uses: usesOf,
    answer(answer) {
      forced = answer
    },
    async close() {
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}

/** A `baseUrl` nothing listens on: a fake started and closed again. */
export async function closedBaseUrl(): Promise<string> {
  const fake = await startFakeTalonOne()
  await fake.close()
  return fake.baseUrl
}
