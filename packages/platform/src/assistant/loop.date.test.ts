import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { Caller, Logger, ToolDefinition, ToolSurface } from '@nymbalhq/types'
import {
  scriptedAi,
  type ScriptedReply,
  type ScriptedRequest,
} from '../../tests/support/scripted-ai.js'
import { calendarDayOf, todayLineOf } from '../../tests/support/today-line.js'
import { runAssistantTurn } from './loop.js'

// Today's date in the model's instructions, through the real loop with the model scripted and the clock injected.
// - AC-7: property, the date line's day and weekday are the clock's calendar day in the store's time zone (UTC with no
//   store), not the UTC day or the server's.
// - AC-8: every request of a turn carries the date of the clock at the turn's start; the next turn carries the clock's
//   new date.

const caller: Caller = {
  auth: { userId: 'admin-1', roles: ['admin'] },
  agent: { name: 'nymbal-assistant' },
}

const silent: Logger = {
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silent,
}

const ORDERS: ToolDefinition = {
  name: 'admin_orders_list',
  title: 'admin.orders.list',
  description: 'admin_orders_list',
  inputSchema: { type: 'object', properties: {} },
  scope: 'admin',
  kind: 'read',
  route: { method: 'GET', path: '/api/admin/orders', command: null },
}

const tools: ToolSurface = {
  list: () => [ORDERS],
  call: async () => ({
    content: [{ type: 'text', text: '{"items":[],"total":0}' }],
    structuredContent: { items: [], total: 0 },
  }),
}

/** UTC+14, UTC−11, a half-hour zone, a three-quarter-hour zone, one with summer time and UTC itself. */
const ZONES = [
  'Pacific/Kiritimati',
  'Pacific/Pago_Pago',
  'Europe/London',
  'Asia/Kolkata',
  'Asia/Kathmandu',
  'America/St_Johns',
  'UTC',
] as const

type Store = { name: string; currency: string; timezone: string }

const storeIn = (timezone: string): Store => ({ name: 'Golden Goods', currency: 'GBP', timezone })

const HOUR = 3_600_000
const DAY = 24 * HOUR
const FROM = Date.UTC(2000, 0, 1)
const TO = Date.UTC(2100, 11, 31, 23, 59, 59, 999)

/** The system prompt of every request of one turn, run at the clock `now`, with `script` as the model. */
async function systemsOf(
  now: () => number,
  store: Store | undefined,
  script: (request: ScriptedRequest) => ScriptedReply = () => ({ text: 'Noted.' }),
  messages: Array<{ role: 'user' | 'assistant'; content: string }> = [
    { role: 'user', content: 'How did sales do over the last 30 days?' },
  ],
): Promise<string[]> {
  const model = scriptedAi(script)
  await runAssistantTurn(
    {
      ai: model.ai,
      tools,
      proposals: { get: async () => null },
      logger: silent,
      now,
      ...(store !== undefined && { store }),
    },
    { caller, messages },
    () => undefined,
  )
  return model.requests.map((request) => request.system)
}

const secondLine = (system: string) => system.split('\n')[1]

describe('AC-7: the date line is the calendar day in the store’s time zone', () => {
  it('AC-7: property: for any instant from 2000 to 2100, many within hours of a UTC midnight, and any store time zone of UTC+14 to UTC−11 or no store, the second line names that instant’s calendar day and weekday in the zone (UTC with no store)', async () => {
    const nearMidnight = fc
      .tuple(
        fc.integer({ min: 1, max: Math.floor((TO - FROM) / DAY) - 1 }),
        fc.integer({ min: -14 * HOUR, max: 14 * HOUR }),
      )
      .map(([days, offset]) => FROM + days * DAY + offset)
    const instant = fc.oneof(fc.integer({ min: FROM, max: TO }), nearMidnight)
    const zone = fc.option(fc.constantFrom(...ZONES), { nil: undefined })

    await fc.assert(
      fc.asyncProperty(instant, zone, async (at, z) => {
        const [system] = await systemsOf(() => at, z === undefined ? undefined : storeIn(z))

        expect(secondLine(system!)).toBe(todayLineOf(at, z ?? 'UTC'))
      }),
      { numRuns: 300 },
    )
  })

  it('AC-7: near midnight UTC the line names the zone’s day, not the UTC day: Sunday 2026-11-08 in Kiritimati at 23:30Z on the 7th, Friday 2026-11-06 in Pago Pago at 05:00Z on the 7th, Wednesday 2026-07-01 in summer-time London at 23:30Z on 30 June', async () => {
    const cases = [
      {
        at: '2026-11-07T23:30:00Z',
        zone: 'Pacific/Kiritimati',
        weekday: 'Sunday',
        day: '2026-11-08',
      },
      {
        at: '2026-11-07T05:00:00Z',
        zone: 'Pacific/Pago_Pago',
        weekday: 'Friday',
        day: '2026-11-06',
      },
      {
        at: '2026-06-30T23:30:00Z',
        zone: 'Europe/London',
        weekday: 'Wednesday',
        day: '2026-07-01',
      },
    ]
    for (const { at, zone, weekday, day } of cases) {
      const instant = Date.parse(at)
      const [system] = await systemsOf(() => instant, storeIn(zone))
      const line = secondLine(system!)

      expect(line, zone).toBe(
        `Today is ${weekday} ${day} in the store's time zone (${zone}); work out dates such as "the last 30 days" from today.`,
      )
      expect(line!.includes(calendarDayOf(instant, 'UTC').day), zone).toBe(false)
    }
  })
})

describe('AC-8: the date is read once a turn', () => {
  it('AC-8: a turn of three requests whose clock passes midnight in London mid-turn sends one system prompt dated the turn’s start, Saturday 2026-11-07; the next turn, started after midnight, is dated Sunday 2026-11-08', async () => {
    const london = storeIn('Europe/London')
    let t = Date.parse('2026-11-07T23:59:00Z')
    const now = () => t
    // Each reply takes a minute: the second request is sent at midnight in London, the third after it.
    const script = (request: ScriptedRequest): ScriptedReply => {
      t += 60_000
      return request.index < 2
        ? { calls: [{ name: ORDERS.name, args: { limit: '50' } }] }
        : { text: 'No orders.' }
    }
    const firstStart = t

    const first = await systemsOf(now, london, script)
    const secondStart = t
    const second = await systemsOf(now, london, () => ({ text: 'Noted.' }), [
      { role: 'user', content: 'How did sales do over the last 30 days?' },
      { role: 'assistant', content: 'No orders.' },
      { role: 'user', content: 'And today?' },
    ])

    expect(first.length).toBe(3)
    expect(first).toEqual(first.map(() => first[0]))
    expect(secondLine(first[0]!)).toBe(todayLineOf(firstStart, 'Europe/London'))
    expect(secondLine(first[0]!)).toBe(
      'Today is Saturday 2026-11-07 in the store\'s time zone (Europe/London); work out dates such as "the last 30 days" from today.',
    )
    expect(secondStart - firstStart).toBe(3 * 60_000)
    expect(second.map(secondLine)).toEqual([todayLineOf(secondStart, 'Europe/London')])
    expect(secondLine(second[0]!)).toBe(
      'Today is Sunday 2026-11-08 in the store\'s time zone (Europe/London); work out dates such as "the last 30 days" from today.',
    )
  })
})
