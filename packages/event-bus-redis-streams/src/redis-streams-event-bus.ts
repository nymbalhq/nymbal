import { randomUUID } from 'node:crypto'
import { Redis } from 'ioredis'
import {
  AdapterError,
  boundedHealthCheck,
  connectionSecrets,
  HEALTH_CHECK_TIMEOUT_MS,
  ValidationError,
  type EventBusAdapter,
  type EventHandler,
  type HealthReport,
  type Logger,
  type NymbalEvent,
  type Subscription,
  type SubscriptionConfig,
} from '@nymbalhq/types'

export interface RedisStreamsEventBusOptions {
  /** `redis://[user:password@]host:port[/db]`; the db index in the path is honoured. */
  url: string
  /** Namespaces the stream (`<prefix>:events`) and so every consumer group on it. */
  prefix: string
  logger?: Logger
  /** How long `publish` waits for the groups it delivers to before it rejects (default 15 000). */
  ackTimeoutMs?: number
  /** How long an entry may stay pending on a consumer before a live consumer of its group takes it over (5 000). */
  claimIdleMs?: number
  /** The approximate length the stream is trimmed to (`XADD MAXLEN ~`, default 10 000). */
  streamMaxLen?: number
}

interface Sub {
  id: string
  patterns: string[]
  regexes: RegExp[]
  handler: EventHandler
  derived: boolean
  live: boolean
  /** Unnamed only: the stream's last entry when it subscribed; it receives what comes after. */
  since?: string
  /** Unnamed only: its starting point is still being read; what the tail feeds it meanwhile waits in the queue. */
  starting: boolean
  queue: Array<{ entryId: string; event: NymbalEvent }>
  running: Promise<void> | null
}

interface Group {
  name: string
  subs: Set<Sub>
  ready: Promise<void>
  draining: Promise<void> | null
  again: boolean
  claimDue: boolean
}

interface Wait {
  event: NymbalEvent<unknown>
  entryId: string | null
  /** `g:<group>` for a named group, `s:<subscription>` for an unnamed subscription of this instance. */
  targets: Set<string>
  startedAt: number
  resolve(): void
  reject(error: unknown): void
  timer: NodeJS.Timeout
}

type Entry = { id: string; event: NymbalEvent | null }

const READ_COUNT = 10
const TAIL_BLOCK_MS = 5_000
/** How often a wait on another instance's consumer asks Redis whether its group acknowledged the entry. */
const ACK_POLL_MS = 25

function compilePattern(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\*]/g, '\\$&').replace(/\\\*/g, '.*')
  return new RegExp(`^${escaped}$`)
}

/** Stream ids are `<ms>-<seq>`; ordered by both parts. */
function compareIds(a: string, b: string): number {
  const [am = 0, as = 0] = a.split('-').map(Number)
  const [bm = 0, bs = 0] = b.split('-').map(Number)
  return am !== bm ? am - bm : as - bs
}

function fieldsOf(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!Array.isArray(raw)) return out
  for (let i = 0; i + 1 < raw.length; i += 2) out[String(raw[i])] = String(raw[i + 1])
  return out
}

/** `[[id, fields], …]` from XREAD, XREADGROUP or XAUTOCLAIM; an entry trimmed away has no fields. */
function entriesOf(raw: unknown): Entry[] {
  if (!Array.isArray(raw)) return []
  const out: Entry[] = []
  for (const item of raw) {
    if (!Array.isArray(item) || typeof item[0] !== 'string') continue
    const json = fieldsOf(item[1])['event']
    let event: NymbalEvent | null = null
    if (json !== undefined) {
      try {
        event = JSON.parse(json) as NymbalEvent
      } catch {
        event = null
      }
    }
    out.push({ id: item[0], event })
  }
  return out
}

function streamEntries(reply: unknown): Entry[] {
  if (!Array.isArray(reply)) return []
  return reply.flatMap((stream: unknown) => (Array.isArray(stream) ? entriesOf(stream[1]) : []))
}

/**
 * An event bus on Redis Streams that keeps the in-process delivery contract. Every event is one entry on
 * `<prefix>:events`. A named subscription is a durable consumer group, shared by every instance, so each event is
 * handled once per name; an unnamed subscription reads the stream from where it subscribed, so every subscriber on
 * every instance receives every event. `publish` resolves once every matching group this instance reads, and every
 * matching unnamed subscription it holds, has handled the event.
 */
export class RedisStreamsEventBus implements EventBusAdapter {
  readonly #cmd: Redis
  readonly #reader: Redis
  readonly #url: string
  readonly #stream: string
  readonly #consumer = randomUUID()
  readonly #logger: Logger | undefined
  readonly #ackTimeoutMs: number
  readonly #claimIdleMs: number
  readonly #streamMaxLen: number
  readonly #subs = new Map<string, Sub>()
  readonly #groups = new Map<string, Group>()
  readonly #waits = new Map<string, Set<Wait>>()
  #tail: Promise<void> | null = null
  #tailStarted: Promise<void> | null = null
  #tailFrom = '0-0'
  #tick: NodeJS.Timeout | null = null
  #poll: NodeJS.Timeout | null = null
  #closed = false

  constructor(cmd: Redis, reader: Redis, options: RedisStreamsEventBusOptions) {
    this.#cmd = cmd
    this.#reader = reader
    this.#url = options.url
    this.#stream = `${options.prefix}:events`
    this.#logger = options.logger
    this.#ackTimeoutMs = options.ackTimeoutMs ?? 15_000
    this.#claimIdleMs = options.claimIdleMs ?? 5_000
    this.#streamMaxLen = options.streamMaxLen ?? 10_000
  }

  capabilities(): readonly string[] {
    return ['publish', 'subscribe', 'wildcard', 'replay', 'consumer-groups', 'fan-out']
  }

  healthCheck(): Promise<HealthReport> {
    return pingRedis(this.#url)
  }

  async publish<T>(event: NymbalEvent<T>): Promise<void> {
    await this.publishBatch([event as NymbalEvent<unknown>])
  }

  async publishBatch(events: NymbalEvent<unknown>[]): Promise<void> {
    for (const event of events) validate(event)
    this.#assertOpen()
    if (events.length === 0) return
    // Registered before the entry exists: a reader may finish with it before XADD's reply is read.
    const waits = events.map((event) => this.#wait(event))
    const pipeline = this.#cmd.pipeline()
    for (const event of events) {
      pipeline.xadd(
        this.#stream,
        'MAXLEN',
        '~',
        this.#streamMaxLen,
        '*',
        'type',
        event.type,
        'event',
        JSON.stringify(event),
      )
    }
    let replies: Array<[Error | null, unknown]> | null
    try {
      replies = await pipeline.exec()
    } catch (error) {
      for (const wait of waits) this.#drop(wait)
      throw error
    }
    const failed =
      replies === null
        ? new AdapterError('publish_failed', 'the stream write was aborted')
        : replies.find(([error]) => error !== null)?.[0]
    if (failed !== undefined && failed !== null) {
      // The relay records the failure and publishes the whole set again later.
      for (const wait of waits) this.#drop(wait)
      throw failed
    }
    replies?.forEach(([, id], i) => {
      waits[i]!.entryId = String(id)
    })
    this.#signalGroups()
    this.#schedulePoll()
    await Promise.all(waits.map((w) => w.promise))
  }

  async replay(events: NymbalEvent<unknown>[]): Promise<void> {
    for (const event of events) {
      validate(event)
      const derived = [...this.#subs.values()].filter((s) => s.derived && matches(s, event.type))
      await Promise.all(derived.map((s) => this.#run(s, event)))
    }
  }

  async subscribe(
    eventPattern: string | string[],
    handler: EventHandler,
    config?: SubscriptionConfig,
  ): Promise<Subscription> {
    this.#assertOpen()
    // The tail starts before an unnamed subscription takes its starting point, so it reads everything after it.
    await this.#startTail()
    const patterns = Array.isArray(eventPattern) ? eventPattern : [eventPattern]
    const sub: Sub = {
      id: randomUUID(),
      patterns,
      regexes: patterns.map(compilePattern),
      handler,
      derived: config?.derived === true,
      live: true,
      starting: false,
      queue: [],
      running: null,
    }
    const name = config?.name
    if (name !== undefined) {
      let group = this.#groups.get(name)
      if (group === undefined) {
        group = {
          name,
          subs: new Set(),
          ready: this.#createGroup(name),
          draining: null,
          again: false,
          claimDue: false,
        }
        this.#groups.set(name, group)
      }
      try {
        await group.ready
      } catch (error) {
        if (group.subs.size === 0) this.#groups.delete(name)
        throw error
      }
      group.subs.add(sub)
      this.#subs.set(sub.id, sub)
      // A durable group may hold entries from before this subscription, or ones a dead consumer left pending.
      group.claimDue = true
      void this.#drainGroup(group)
    } else {
      // Joins before its starting point is read: an entry the tail reads meanwhile is queued, then kept if it is later.
      sub.since = this.#tailFrom
      sub.starting = true
      this.#subs.set(sub.id, sub)
      let last: string
      try {
        last = await this.#lastId()
      } catch (error) {
        sub.live = false
        this.#subs.delete(sub.id)
        throw error
      }
      sub.since = last
      sub.starting = false
      const later = sub.queue.filter((q) => compareIds(q.entryId, last) > 0)
      sub.queue.splice(0, sub.queue.length, ...later)
      if (sub.queue.length > 0 && sub.running === null) sub.running = this.#runQueue(sub)
    }
    this.#startTick()
    const self = this
    return {
      id: sub.id,
      patterns,
      async unsubscribe() {
        await self.#unsubscribe(sub.id)
      },
    }
  }

  async unsubscribe(subscription: Subscription): Promise<void> {
    await this.#unsubscribe(subscription.id)
  }

  async close(): Promise<void> {
    if (this.#closed) return
    this.#closed = true
    if (this.#tick !== null) clearInterval(this.#tick)
    if (this.#poll !== null) clearTimeout(this.#poll)
    this.#tick = null
    this.#poll = null
    // A wait on this instance's readers ends with them.
    for (const waits of [...this.#waits.values()]) {
      for (const wait of [...waits]) {
        this.#drop(wait)
        wait.resolve()
      }
    }
    this.#reader.disconnect()
    await this.#tail?.catch(() => undefined)
    const groups = [...this.#groups.values()]
    await Promise.all([
      ...groups.map((g) => g.draining?.catch(() => undefined)),
      ...[...this.#subs.values()].map((s) => s.running?.catch(() => undefined)),
    ])
    for (const sub of this.#subs.values()) sub.live = false
    this.#subs.clear()
    await Promise.all(groups.map((g) => this.#leaveGroup(g.name)))
    this.#groups.clear()
    await this.#cmd.quit().catch(() => this.#cmd.disconnect())
  }

  // ── Waiting ────────────────────────────────────────────────────────────────

  #wait(event: NymbalEvent<unknown>): Wait & { promise: Promise<void> } {
    const targets = new Set<string>()
    for (const group of this.#groups.values()) {
      if ([...group.subs].some((s) => s.live && matches(s, event.type)))
        targets.add(`g:${group.name}`)
    }
    for (const sub of this.#subs.values()) {
      if (sub.since !== undefined && sub.live && !sub.starting && matches(sub, event.type))
        targets.add(`s:${sub.id}`)
    }
    let resolve!: () => void
    let reject!: (error: unknown) => void
    const promise = new Promise<void>((res, rej) => {
      resolve = res
      reject = rej
    })
    const wait = {
      event,
      entryId: null,
      targets,
      startedAt: Date.now(),
      resolve,
      reject,
      promise,
      timer: undefined as unknown as NodeJS.Timeout,
    }
    if (targets.size === 0) {
      resolve()
      return wait
    }
    wait.timer = setTimeout(() => this.#timeout(wait), this.#ackTimeoutMs)
    const forEvent = this.#waits.get(event.id) ?? new Set<Wait>()
    forEvent.add(wait)
    this.#waits.set(event.id, forEvent)
    return wait
  }

  #timeout(wait: Wait): void {
    if (!this.#drop(wait)) return
    const pending = [...wait.targets]
    this.#logger?.error(
      {
        eventId: wait.event.id,
        eventType: wait.event.type,
        entryId: wait.entryId,
        unacknowledged: pending,
      },
      'redis streams publish timed out waiting for its handlers',
    )
    wait.reject(
      new AdapterError(
        'publish_timeout',
        `publish of ${wait.event.type} (${wait.event.id}) was not handled within ${this.#ackTimeoutMs} ms by ${pending.join(', ')}`,
        { context: { eventId: wait.event.id, unacknowledged: pending } },
      ),
    )
  }

  /** Forgets `wait`; false when it was already settled. */
  #drop(wait: Wait): boolean {
    const forEvent = this.#waits.get(wait.event.id)
    if (forEvent === undefined || !forEvent.delete(wait)) return false
    if (forEvent.size === 0) this.#waits.delete(wait.event.id)
    clearTimeout(wait.timer)
    return true
  }

  /** `target` has finished with `eventId`: a wait left with nothing to wait on resolves. */
  #settle(eventId: string, target: string): void {
    for (const wait of [...(this.#waits.get(eventId) ?? [])]) this.#remove(wait, target)
  }

  #settleEverywhere(target: string): void {
    for (const waits of [...this.#waits.values()]) {
      for (const wait of [...waits]) this.#remove(wait, target)
    }
  }

  #remove(wait: Wait, target: string): void {
    if (!wait.targets.delete(target) || wait.targets.size > 0) return
    if (this.#drop(wait)) wait.resolve()
  }

  /**
   * A group's entry may be handled by another instance's consumer: asks Redis, for each wait still on a group, whether
   * the group has delivered the entry and holds it pending no more.
   */
  #schedulePoll(): void {
    if (this.#poll !== null || this.#closed || this.#waits.size === 0) return
    this.#poll = setTimeout(() => {
      this.#poll = null
      void this.#pollAcks().finally(() => this.#schedulePoll())
    }, ACK_POLL_MS)
  }

  async #pollAcks(): Promise<void> {
    const due: Array<{ wait: Wait; group: string }> = []
    const now = Date.now()
    for (const waits of this.#waits.values()) {
      for (const wait of waits) {
        if (wait.entryId === null || now - wait.startedAt < ACK_POLL_MS) continue
        for (const target of wait.targets) {
          if (target.startsWith('g:')) due.push({ wait, group: target.slice(2) })
        }
      }
    }
    if (due.length === 0) return
    try {
      const pipeline = this.#cmd.pipeline().xinfo('GROUPS', this.#stream)
      for (const { wait, group } of due) {
        pipeline.xpending(this.#stream, group, wait.entryId!, wait.entryId!, 1)
      }
      const replies = (await pipeline.exec()) ?? []
      const delivered = new Map<string, string>()
      const [infoError, info] = replies[0] ?? [null, []]
      if (infoError !== null) return
      for (const raw of (info as unknown[]) ?? []) {
        const fields = fieldsOf(raw)
        if (fields['name'] !== undefined) {
          delivered.set(fields['name'], fields['last-delivered-id'] ?? '0-0')
        }
      }
      due.forEach(({ wait, group }, i) => {
        const [error, pending] = replies[i + 1] ?? [null, null]
        const last = delivered.get(group)
        if (error !== null || last === undefined || !Array.isArray(pending)) return
        if (pending.length === 0 && compareIds(last, wait.entryId!) >= 0) {
          this.#remove(wait, `g:${group}`)
        }
      })
    } catch (err) {
      if (!this.#closed) this.#logger?.warn({ err }, 'redis streams: acknowledgement poll failed')
    }
  }

  // ── Reading ────────────────────────────────────────────────────────────────

  async #createGroup(name: string): Promise<void> {
    try {
      await this.#cmd.xgroup('CREATE', this.#stream, name, '$', 'MKSTREAM')
    } catch (error) {
      if (!String((error as Error).message).includes('BUSYGROUP')) throw error
    }
  }

  async #lastId(): Promise<string> {
    const last = (await this.#cmd.xrevrange(this.#stream, '+', '-', 'COUNT', 1)) as Array<
      [string, string[]]
    >
    return last[0]?.[0] ?? '0-0'
  }

  /** One reader per instance tails the stream: it feeds the unnamed subscriptions and wakes the groups. */
  #startTail(): Promise<void> {
    this.#tailStarted ??= this.#lastId().then((last) => {
      this.#tailFrom = last
      this.#tail = this.#runTail()
    })
    return this.#tailStarted
  }

  async #runTail(): Promise<void> {
    while (!this.#closed) {
      let reply: unknown
      try {
        reply = await this.#reader.xread(
          'COUNT',
          100,
          'BLOCK',
          TAIL_BLOCK_MS,
          'STREAMS',
          this.#stream,
          this.#tailFrom,
        )
      } catch (err) {
        if (this.#closed) return
        this.#logger?.warn({ err }, 'redis streams: reading the stream failed; retrying')
        await new Promise((r) => setTimeout(r, 200))
        continue
      }
      const entries = streamEntries(reply)
      for (const entry of entries) {
        this.#tailFrom = entry.id
        if (entry.event !== null) this.#feedUnnamed(entry.id, entry.event)
      }
      if (entries.length > 0) this.#signalGroups()
    }
  }

  #feedUnnamed(entryId: string, event: NymbalEvent): void {
    for (const sub of this.#subs.values()) {
      if (sub.since === undefined || !sub.live || compareIds(entryId, sub.since) <= 0) continue
      if (!matches(sub, event.type)) continue
      sub.queue.push({ entryId, event })
      if (sub.running === null && !sub.starting) sub.running = this.#runQueue(sub)
    }
  }

  /** An unnamed subscription takes its events one at a time, in stream order. */
  async #runQueue(sub: Sub): Promise<void> {
    try {
      for (let next = sub.queue.shift(); next !== undefined; next = sub.queue.shift()) {
        if (!sub.live || this.#closed) break
        await this.#run(sub, next.event)
        this.#settle(next.event.id, `s:${sub.id}`)
      }
    } finally {
      sub.running = null
      sub.queue.length = 0
    }
  }

  #startTick(): void {
    if (this.#tick !== null || this.#closed) return
    const every = Math.min(1_000, Math.max(50, Math.floor(this.#claimIdleMs / 4)))
    this.#tick = setInterval(() => {
      for (const group of this.#groups.values()) {
        group.claimDue = true
        void this.#drainGroup(group)
      }
    }, every)
    this.#tick.unref()
  }

  #signalGroups(): void {
    for (const group of this.#groups.values()) void this.#drainGroup(group)
  }

  /**
   * A group's consumer on this instance, one pass at a time: entries a dead consumer left pending past `claimIdleMs`
   * first (when due), then new ones, each handled and acknowledged in stream order.
   */
  #drainGroup(group: Group): Promise<void> {
    if (group.draining !== null) {
      group.again = true
      return group.draining
    }
    group.draining = (async () => {
      do {
        group.again = false
        if (group.claimDue) {
          group.claimDue = false
          await this.#claim(group)
        }
        await this.#readNew(group)
      } while (group.again && !this.#closed && group.subs.size > 0)
    })()
      .catch((err: unknown) => {
        if (!this.#closed)
          this.#logger?.warn({ err, group: group.name }, 'redis streams: group read failed')
      })
      .finally(() => {
        group.draining = null
        // Asked for again after the last pass looked: one more.
        if (group.again && !this.#closed && group.subs.size > 0) void this.#drainGroup(group)
      })
    return group.draining
  }

  async #readNew(group: Group): Promise<void> {
    for (;;) {
      if (this.#closed || group.subs.size === 0) return
      let reply: unknown
      try {
        reply = await this.#cmd.xreadgroup(
          'GROUP',
          group.name,
          this.#consumer,
          'COUNT',
          READ_COUNT,
          'STREAMS',
          this.#stream,
          '>',
        )
      } catch (error) {
        // The stream or the group was deleted under us: create it again and read on the next pass.
        if (String((error as Error).message).includes('NOGROUP')) {
          await this.#createGroup(group.name)
          return
        }
        throw error
      }
      const entries = streamEntries(reply)
      await this.#handle(group, entries)
      if (entries.length < READ_COUNT) return
    }
  }

  async #claim(group: Group): Promise<void> {
    let start = '0-0'
    do {
      if (this.#closed || group.subs.size === 0) return
      const reply = (await this.#cmd.xautoclaim(
        this.#stream,
        group.name,
        this.#consumer,
        this.#claimIdleMs,
        start,
        'COUNT',
        READ_COUNT,
      )) as [string, unknown, unknown?]
      start = reply[0]
      const entries = entriesOf(reply[1])
      if (entries.length > 0) {
        this.#logger?.info(
          { group: group.name, entries: entries.map((e) => e.id) },
          'redis streams: took over entries a consumer left pending',
        )
      }
      await this.#handle(group, entries)
    } while (start !== '0-0')
  }

  /**
   * Handles each entry for the group's matching subscriptions, then acknowledges it; non-matching ones in bulk. Once
   * the group has no live subscription here, the rest stay pending, for a live consumer of the group to take over.
   */
  async #handle(group: Group, entries: Entry[]): Promise<void> {
    const skipped: string[] = []
    for (const entry of entries) {
      if (![...group.subs].some((s) => s.live)) break
      const event = entry.event
      const subs =
        event === null ? [] : [...group.subs].filter((s) => s.live && matches(s, event.type))
      if (event === null || subs.length === 0) {
        if (event === null)
          this.#logger?.error({ entryId: entry.id }, 'redis streams: unreadable entry')
        skipped.push(entry.id)
        continue
      }
      await Promise.all(subs.map((s) => this.#run(s, event)))
      await this.#cmd.xack(this.#stream, group.name, entry.id)
      this.#settle(event.id, `g:${group.name}`)
    }
    if (skipped.length > 0) await this.#cmd.xack(this.#stream, group.name, ...skipped)
  }

  /** Runs one handler; an error is logged and acknowledged like a success, as the in-process bus does. */
  async #run(sub: Sub, event: NymbalEvent): Promise<void> {
    try {
      await sub.handler(event)
    } catch (err) {
      this.#logger?.error(
        { err, subscriptionId: sub.id, eventType: event.type, eventId: event.id },
        'Event handler failed',
      )
    }
  }

  // ── Leaving ────────────────────────────────────────────────────────────────

  async #unsubscribe(id: string): Promise<void> {
    const sub = this.#subs.get(id)
    if (sub === undefined) return
    sub.live = false
    this.#subs.delete(id)
    if (sub.since !== undefined) {
      sub.queue.length = 0
      this.#settleEverywhere(`s:${id}`)
      return
    }
    for (const group of this.#groups.values()) {
      if (!group.subs.delete(sub) || group.subs.size > 0) continue
      // No live reader of the group on this instance: no publish here waits on it any more.
      this.#groups.delete(group.name)
      this.#settleEverywhere(`g:${group.name}`)
      await group.draining?.catch(() => undefined)
      if (!this.#closed) await this.#leaveGroup(group.name)
    }
  }

  /** Removes this instance's consumer from the group when it holds nothing pending, which would be lost with it. */
  async #leaveGroup(name: string): Promise<void> {
    if (this.#groups.has(name) && !this.#closed) return
    try {
      const summary = (await this.#cmd.xpending(
        this.#stream,
        name,
        '-',
        '+',
        1,
        this.#consumer,
      )) as unknown[]
      if (summary.length === 0) {
        await this.#cmd.xgroup('DELCONSUMER', this.#stream, name, this.#consumer)
      }
    } catch (err) {
      this.#logger?.debug({ err, group: name }, 'redis streams: consumer left in place')
    }
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new AdapterError('closed', 'the redis streams event bus is closed')
    }
  }
}

function matches(sub: Sub, type: string): boolean {
  return sub.regexes.some((re) => re.test(type))
}

function validate(event: NymbalEvent<unknown>): void {
  if (!event.id || !event.type || !event.timestamp || !event.source) {
    throw new ValidationError('Event is missing required envelope fields', { context: { event } })
  }
  if (!event.metadata || !event.metadata.storeId || !event.metadata.environment) {
    throw new ValidationError('Event metadata is missing required fields', { context: { event } })
  }
}

/**
 * PING on a client of its own that never retries and queues nothing, disconnected afterwards: the store's or bus's own
 * clients retry a closed port for as long as the process lives, so they cannot answer within the bound.
 */
function pingRedis(url: string, timeoutMs = HEALTH_CHECK_TIMEOUT_MS): Promise<HealthReport> {
  const client = new Redis(url, {
    lazyConnect: true,
    retryStrategy: () => null,
    maxRetriesPerRequest: 0,
    enableOfflineQueue: false,
    connectTimeout: timeoutMs,
  })
  // connect() rejects with the same error, and the report carries it; without a listener ioredis would throw it.
  client.on('error', () => undefined)
  return boundedHealthCheck(
    async () => {
      await client.connect()
      await client.ping()
      return { status: 'healthy' }
    },
    { timeoutMs, redact: connectionSecrets(url) },
  ).finally(() => client.disconnect())
}

async function connect(
  url: string,
  logger: Logger | undefined,
  role: 'commands' | 'reader',
): Promise<Redis> {
  // The reader blocks on the stream and retries for as long as it takes; a command gives up, so a publish fails.
  const client = new Redis(url, {
    lazyConnect: true,
    ...(role === 'reader' && { maxRetriesPerRequest: null }),
  })
  client.on('error', (err: Error) => logger?.warn({ err, role }, 'redis connection error'))
  try {
    await client.connect()
  } catch (error) {
    client.disconnect()
    throw error
  }
  return client
}

/** Connects the bus's two clients: one for commands, one for the blocking read of the stream. */
export async function createRedisStreamsEventBus(
  options: RedisStreamsEventBusOptions,
): Promise<RedisStreamsEventBus> {
  const cmd = await connect(options.url, options.logger, 'commands')
  try {
    const reader = await connect(options.url, options.logger, 'reader')
    return new RedisStreamsEventBus(cmd, reader, options)
  } catch (error) {
    cmd.disconnect()
    throw error
  }
}
