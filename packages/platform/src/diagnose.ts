import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  ASSISTANT_MASK_FIELDS,
  DEFAULT_ASSISTANT_MASK,
  nymbalConfigSchema,
  resolveOriginLock,
  slotFolder,
  type NymbalConfig,
} from '@nymbalhq/config'
import {
  boundedHealthCheck,
  ConfigError,
  connectionSecrets,
  displayUrl,
  errorText,
  HEALTH_CHECK_TIMEOUT_MS,
  type CommerceSlot,
  type DocumentStoreAdapter,
  type HealthReport,
  type HealthStatus,
  type Logger,
  type OriginLockRule,
  type ResolvedOriginLock,
  type SecurityNetwork,
  type Slot,
} from '@nymbalhq/types'
import {
  declaredSettings,
  importAdapterModule,
  resolveChoice,
  type Choice,
} from './adapters/resolve.js'
import {
  checkInjectedSlot,
  COMMERCE_SLOTS,
  resolvePaymentsAdapter,
  resolveSecurityAdapter,
  securityChoice,
  slotBuilders,
  type InjectedAdapters,
} from './adapters/registry.js'
import {
  createCommandStore,
  rawClients,
  sqliteFile,
  type CommandStore,
  type RawClients,
} from './db/command-store.js'
import { migrationState } from './db/migrate.js'
import { createLogger } from './logger.js'
import { buildDocumentStore, buildEventBus, buildMedia, redisUrlOf } from './platform.js'
import { agentReadiness } from './agents/readiness.js'
import { createEventLogRepository, retryFloor } from './repositories/event-log.js'
import { buildRepositories, type SettingRow } from './repositories/index.js'
import { listStoredSettings, settingValues } from './settings/load.js'
import type { SettingValue } from './settings/resolve.js'
import { scrub, scrubbingLogger } from './settings/secret-set.js'

/** `ok` is a check with no health semantics (config, a package, migrations); the rest are a health report's. */
export type DiagnosisStatus = HealthStatus | 'ok'

export interface DiagnosisCheck {
  name: string
  status: DiagnosisStatus
  detail: string
}

export interface DiagnosisReport {
  checks: DiagnosisCheck[]
  /**
   * What the security adapter offers the HTTP layer (`network()`), read from the adapter built for `slot security`:
   * `unknown` when it failed to build or `network()` threw. Absent when the config did not parse.
   */
  network?: { adapter: string; contribution: SecurityNetwork } | 'unknown'
  /**
   * Whether the CDN sends the origin secret, present only when `NYMBAL_ORIGIN_SECRET` resolves: the security adapter's
   * answer, `unmanaged` when it cannot tell (no `originLockRule`), `unknown` when it failed to build, threw or timed out.
   */
  originLock?: OriginLockRule | 'unknown' | 'unmanaged'
}

export interface DiagnoseOptions {
  /** The project's adapters, one per slot whose provider is `custom`, as `createApp` takes them. */
  adapters?: InjectedAdapters
  logger?: Logger
  /** Each check's bound; `HEALTH_CHECK_TIMEOUT_MS` when not given. */
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
  sqlitePath?: string
  postgresUrl?: string
  mediaRoot?: string
  /** Where the migrations journal is read; the platform's own migrations when not given. */
  migrationsRoot?: string
}

const OWN_MIGRATIONS = fileURLToPath(new URL('../migrations', import.meta.url))

const PRIMITIVES = ['documentStore', 'eventBus', 'media'] as const
type PrimitiveName = (typeof PRIMITIVES)[number]

/** What a primitive or a slot adapter may answer; a third-party one may lack `healthCheck`. */
interface Checkable {
  healthCheck?: () => Promise<HealthReport>
}

type Outcome<T> = { ok: true; value: T } | { ok: false; detail: string }

/**
 * Runs `run` within the bound. Something it opens after the bound has passed is handed to `dispose`, so a late
 * connection is not left open.
 */
async function within<T>(
  timeoutMs: number,
  run: () => Promise<T>,
  dispose?: (late: T) => Promise<void>,
): Promise<Outcome<T>> {
  let timer: NodeJS.Timeout | undefined
  let timedOut = false
  // A run that throws before returning a promise is a failed outcome like a rejection, not an escape.
  const work = Promise.resolve().then(run)
  const timeout = new Promise<Outcome<T>>((resolveTimeout) => {
    timer = setTimeout(() => {
      timedOut = true
      resolveTimeout({ ok: false, detail: `timed out after ${timeoutMs} ms` })
    }, timeoutMs)
  })
  try {
    return await Promise.race([
      work.then(
        (value): Outcome<T> => ({ ok: true, value }),
        (error: unknown): Outcome<T> => ({ ok: false, detail: errorText(error) }),
      ),
      timeout,
    ])
  } finally {
    clearTimeout(timer)
    if (timedOut && dispose !== undefined) {
      // The check is already reported as timed out; a late open that fails, or a close that does, adds nothing.
      work.then(dispose).catch(() => undefined)
    }
  }
}

/** A store that did not open, held by the slot adapters that are built over one: any use of it rejects. */
function unavailableCommandStore(kind: CommandStore['kind']): CommandStore {
  const refuse = () => Promise.reject(new Error('the command store is down'))
  return { kind, read: refuse, transaction: refuse, savepoint: refuse, close: async () => {} }
}

/** The raw clients of a store that did not open: any use of a client throws, as a down store's would. */
function unavailableRawClients(kind: CommandStore['kind']): RawClients {
  const refuse = () => {
    throw new Error('the command store is down')
  }
  const client = new Proxy({}, { get: () => refuse })
  return kind === 'sqlite'
    ? { kind, db: client as never, raw: client as never }
    : { kind, db: client as never, pool: client as never }
}

function unavailableDocumentStore(): DocumentStoreAdapter {
  const refuse = () => Promise.reject(new Error('the document store is down'))
  return {
    capabilities: () => [],
    get: refuse,
    put: refuse,
    delete: refuse,
    query: refuse,
    batchGet: refuse,
    batchPut: refuse,
    replaceCollection: refuse,
    close: async () => {},
  }
}

/** A line's detail: what was checked (a provider, and where it connects), then what the check said. */
function described(what: string, detail: string | undefined): string {
  return detail === undefined || detail === '' ? what : `${what}: ${detail}`
}

/**
 * The native slots that query the command store. Their healthCheck answers ok without touching it, so with the store
 * down they would read ok while every request they serve fails.
 */
const OVER_THE_COMMAND_STORE: ReadonlySet<CommerceSlot> = new Set(['search', 'reviews'])

function notChecked(prerequisite: string): string {
  return `not checked: ${prerequisite} down`
}

/**
 * Checks a project without changing it: its config, the packages its providers live in, the command store and its
 * migrations, and the health of every commerce slot, the security slot and every primitive. It builds what `createApp`
 * builds, through the same registry and constructors, and nothing more: no warm-up, no relay, no sweeper, no migrator,
 * no seed, and no primitive's `initialize()` (the security adapter's makes no request). The command store is opened read-only. Every connection is closed before it returns.
 */
export async function diagnose(
  input: NymbalConfig,
  options: DiagnoseOptions = {},
): Promise<DiagnosisReport> {
  const parsed = nymbalConfigSchema.safeParse(input)
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map(
        (issue) => `${issue.path.length > 0 ? issue.path.join('.') : '<root>'}: ${issue.message}`,
      )
      .join('; ')
    return { checks: [{ name: 'config', status: 'down', detail }] }
  }
  const config = parsed.data
  const timeoutMs = options.timeoutMs ?? HEALTH_CHECK_TIMEOUT_MS
  const env = options.env ?? process.env
  const logger = scrubbingLogger(
    options.logger ?? createLogger({ base: { store: config.store.name } }),
  )
  const injected = options.adapters ?? {}
  const infrastructure = config.infrastructure
  const choices: Record<Slot, Choice> = {
    ...(Object.fromEntries(COMMERCE_SLOTS.map((s) => [s, config.commerce[s]])) as Record<
      CommerceSlot,
      Choice
    >),
    documentStore: infrastructure.documentStore,
    eventBus: infrastructure.eventBus,
    media: infrastructure.media,
    security: securityChoice(config),
  }
  const providers = Object.fromEntries(
    Object.entries(choices).map(([slot, choice]) => [slot, choice.provider]),
  ) as Record<Slot, string>

  // Each slot that resolves to a package, resolved as createApp resolves it: the package it names, or why it fails.
  const packages: DiagnosisCheck[] = []
  for (const slot of [...COMMERCE_SLOTS, ...PRIMITIVES, 'security'] as const) {
    const resolution = resolveChoice(slot, choices[slot])
    if (resolution.kind !== 'package') continue
    const found = await within(timeoutMs, () => importAdapterModule(slot, choices[slot], env))
    packages.push({
      name: `package ${slotFolder(slot)}`,
      status: found.ok ? 'ok' : 'down',
      detail: found.ok ? resolution.package : found.detail,
    })
  }

  const closers: Array<() => Promise<void>> = []
  let commandStore: CommandStore | undefined
  let storeCheck: DiagnosisCheck
  let migrationsCheck: DiagnosisCheck
  const storeOptions = {
    readOnly: true,
    ...(options.sqlitePath !== undefined && { sqlitePath: options.sqlitePath }),
    ...(options.postgresUrl !== undefined && { postgresUrl: options.postgresUrl }),
  }
  const postgresUrl =
    options.postgresUrl ?? (env['DATABASE_URL'] === '' ? undefined : env['DATABASE_URL'])
  const redisUrl = redisUrlOf(config, env)
  const where =
    infrastructure.commandStore === 'sqlite'
      ? `sqlite ${sqliteFile(storeOptions)}`
      : `postgres ${postgresUrl === undefined ? '(no DATABASE_URL)' : displayUrl(postgresUrl)}`
  if (infrastructure.commandStore === 'sqlite' && !existsSync(resolve(sqliteFile(storeOptions)))) {
    storeCheck = {
      name: 'command store',
      status: 'down',
      detail: `no database at ${sqliteFile(storeOptions)}: run \`nymbal migrate\``,
    }
  } else {
    const opened = await within(
      timeoutMs,
      async () => {
        const store = createCommandStore(config, storeOptions)
        try {
          const clients = rawClients(store)
          if (clients.kind === 'sqlite') clients.raw.prepare('SELECT 1').get()
          else await clients.pool.query('SELECT 1')
          return store
        } catch (error) {
          // The probe's error is the one reported; closing a store that never answered may fail as well.
          await store.close().catch(() => undefined)
          throw error
        }
      },
      (late) => late.close(),
    )
    if (opened.ok) {
      commandStore = opened.value
      closers.push(() => opened.value.close())
      storeCheck = { name: 'command store', status: 'healthy', detail: where }
    } else {
      storeCheck = { name: 'command store', status: 'down', detail: `${where}: ${opened.detail}` }
    }
  }
  if (commandStore === undefined) {
    migrationsCheck = { name: 'migrations', status: 'down', detail: notChecked('command store') }
  } else {
    const store = commandStore
    const state = await within(timeoutMs, () =>
      migrationState(store, { migrationsRoot: options.migrationsRoot ?? OWN_MIGRATIONS }),
    )
    migrationsCheck = !state.ok
      ? { name: 'migrations', status: 'down', detail: state.detail }
      : state.value.pending > 0
        ? {
            name: 'migrations',
            status: 'down',
            detail: `${state.value.pending} pending: run \`nymbal migrate\``,
          }
        : {
            name: 'migrations',
            status: 'ok',
            detail: `${state.value.applied} applied, none pending`,
          }
  }

  const primitiveOptions = {
    logger,
    env,
    ...(options.postgresUrl !== undefined && { postgresUrl: options.postgresUrl }),
    ...(options.mediaRoot !== undefined && { mediaRoot: options.mediaRoot }),
  }
  /** A primitive as its line names it: the provider, and the server it connects to, if any. */
  const subject = (name: PrimitiveName): string => {
    const provider = providers[name]
    const url =
      provider === 'redis' || provider === 'redis-streams'
        ? redisUrl
        : provider === 'postgres-jsonb'
          ? postgresUrl
          : undefined
    return url === undefined ? provider : `${provider} ${displayUrl(url)}`
  }
  const built: Partial<Record<PrimitiveName, Checkable>> = {}
  const primitiveFailures: Partial<Record<PrimitiveName, string>> = {}
  let documentStore: DocumentStoreAdapter | undefined
  if (infrastructure.documentStore.provider === 'postgres-jsonb' && commandStore === undefined) {
    primitiveFailures.documentStore = notChecked('command store')
  } else {
    const store = await within(
      timeoutMs,
      () => buildDocumentStore(config, primitiveOptions, logger, env),
      (late) => late.close(),
    )
    if (store.ok) {
      documentStore = store.value
      built.documentStore = store.value
      closers.unshift(() => store.value.close())
    } else {
      primitiveFailures.documentStore = described(subject('documentStore'), store.detail)
    }
  }
  const bus = await within(
    timeoutMs,
    () => buildEventBus(config, logger, env),
    (late) => late.close(),
  )
  if (bus.ok) {
    built.eventBus = bus.value
    closers.unshift(() => bus.value.close())
  } else {
    primitiveFailures.eventBus = described(subject('eventBus'), bus.detail)
  }
  const media = await within(timeoutMs, () => buildMedia(config, primitiveOptions, logger, env))
  if (media.ok) built.media = media.value
  else primitiveFailures.media = described(subject('media'), media.detail)

  const health = (subject: Checkable): Promise<HealthReport> => {
    if (typeof subject.healthCheck !== 'function') {
      return Promise.resolve({ status: 'degraded', detail: 'no healthCheck' })
    }
    const check = subject.healthCheck.bind(subject)
    return boundedHealthCheck(() => check(), { timeoutMs })
  }

  // The rows Settings hold fill each slot as createApp fills it; a store that did not open holds none.
  const stored: Outcome<SettingRow[]> =
    commandStore === undefined
      ? { ok: true, value: [] }
      : await within(timeoutMs, () => listStoredSettings(commandStore))
  /** The values Settings give `slot`'s declared fields, decrypted; a row that cannot be read fails the slot. */
  const settingsOf = async (slot: CommerceSlot): Promise<SettingValue[]> => {
    const provider = providers[slot]
    if (provider === 'custom') return []
    const declared = declaredSettings(await importAdapterModule(slot, choices[slot], env))
    if (declared.length === 0) return []
    if (!stored.ok) throw new Error(`settings not read: ${stored.detail}`)
    return settingValues(config, [{ slot, provider, declared }], stored.value, env, logger)
  }

  const slots: DiagnosisCheck[] = []
  const adapterLogger = logger.child({ layer: 'adapter' })
  const builderDeps = {
    config,
    logger: adapterLogger,
    sql:
      commandStore === undefined
        ? unavailableRawClients(infrastructure.commandStore)
        : rawClients(commandStore),
    repos: buildRepositories(
      commandStore ?? unavailableCommandStore(infrastructure.commandStore),
      documentStore ?? unavailableDocumentStore(),
    ),
    injected,
  }
  for (const slot of COMMERCE_SLOTS) {
    const provider = providers[slot]
    if (provider === 'native' && OVER_THE_COMMAND_STORE.has(slot) && commandStore === undefined) {
      slots.push({ name: `slot ${slot}`, status: 'down', detail: notChecked('command store') })
      continue
    }
    const adapter = await within(timeoutMs, async (): Promise<Checkable | null> => {
      checkInjectedSlot(config, slot, injected)
      const settings = await settingsOf(slot)
      return slot === 'payments'
        ? resolvePaymentsAdapter(config, adapterLogger, injected, settings)
        : slotBuilders({ ...builderDeps, settings })[slot]()
    })
    if (!adapter.ok) {
      slots.push({
        name: `slot ${slot}`,
        status: 'down',
        detail: described(provider, adapter.detail),
      })
    } else if (adapter.value === null) {
      slots.push({ name: `slot ${slot}`, status: 'ok', detail: provider })
    } else {
      slots.push(fromReport(`slot ${slot}`, provider, await health(adapter.value)))
    }
    if (slot === 'ai' && slots.at(-1)?.status !== 'down') {
      slots.push(aiHostCheck(config, provider, adapter.ok ? adapter.value : null))
    }
  }

  const securityAdapter = await within(timeoutMs, () =>
    resolveSecurityAdapter(config, adapterLogger, env),
  )
  let network: DiagnosisReport['network'] = 'unknown'
  if (securityAdapter.ok) {
    try {
      network = {
        adapter: config.security.adapter,
        contribution: securityAdapter.value.network?.() ?? {},
      }
    } catch {
      // The offer stays unknown, which the trust proxy check reports; it never reads as an empty one.
    }
  }
  const originLock = await originLockOf(config, env, timeoutMs, securityAdapter)
  slots.push(
    securityAdapter.ok
      ? fromReport('slot security', providers.security, await health(securityAdapter.value))
      : {
          name: 'slot security',
          status: 'down',
          detail: described(providers.security, securityAdapter.detail),
        },
  )

  const primitives: DiagnosisCheck[] = []
  for (const name of PRIMITIVES) {
    const primitive = built[name]
    if (primitive === undefined) {
      primitives.push({
        name: `primitive ${slotFolder(name)}`,
        status: 'down',
        detail: primitiveFailures[name] ?? '',
      })
    } else {
      primitives.push(
        fromReport(`primitive ${slotFolder(name)}`, subject(name), await health(primitive)),
      )
    }
  }

  const eventsCheck: DiagnosisCheck =
    commandStore === undefined
      ? { name: 'events', status: 'down', detail: notChecked('command store') }
      : migrationsCheck.status !== 'ok'
        ? { name: 'events', status: 'down', detail: notChecked('migrations') }
        : await eventLogCheck(commandStore, timeoutMs, config.events.retentionDays)

  for (const close of closers) {
    const closed = await within(timeoutMs, close)
    if (!closed.ok) logger.debug({ detail: closed.detail }, 'diagnose: a connection did not close')
  }

  const secrets = [postgresUrl, redisUrl].flatMap((url) =>
    url === undefined ? [] : connectionSecrets(url, { user: false }),
  )
  const checks = [
    { name: 'config', status: 'ok' as const, detail: 'valid' },
    ...packages,
    storeCheck,
    migrationsCheck,
    ...slots,
    ...primitives,
    eventsCheck,
    agentReadiness(config, env),
  ].map((check) => ({
    ...check,
    detail: scrub(secrets.reduce((text, secret) => text.split(secret).join('***'), check.detail)),
  }))
  return { checks, network, ...(originLock !== undefined && { originLock }) }
}

async function originLockOf(
  config: NymbalConfig,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  adapter: Outcome<{ originLockRule?: (lock: ResolvedOriginLock) => Promise<OriginLockRule> }>,
): Promise<DiagnosisReport['originLock']> {
  let lock: ResolvedOriginLock | undefined
  try {
    lock = resolveOriginLock(config, env)
  } catch (error) {
    // A malformed secret is the doctor's own `origin lock` line, from the same check.
    if (error instanceof ConfigError) return undefined
    throw error
  }
  if (lock === undefined) return undefined
  if (!adapter.ok) return 'unknown'
  const { originLockRule } = adapter.value
  if (originLockRule === undefined) return 'unmanaged'
  const read = await within(timeoutMs, () => originLockRule.call(adapter.value, lock))
  return read.ok ? read.value : 'unknown'
}

/** How many events show when some are dead; the rest are counted. */
const DEAD_SHOWN = 5

/** The event log's dead events, the oldest first, and how many wait for a retry: read only. */
async function eventLogCheck(
  store: CommandStore,
  timeoutMs: number,
  retentionDays: number,
): Promise<DiagnosisCheck> {
  const eventLog = createEventLogRepository(store)
  const since = retryFloor(new Date(), retentionDays)
  const read = await within(timeoutMs, () =>
    store.read(async (tx) => ({
      dead: await eventLog.countDead(tx),
      retryable: await eventLog.countDead(tx, { since }),
      shown: await eventLog.listDead(tx, DEAD_SHOWN),
      waiting: await eventLog.countRetrying(tx),
    })),
  )
  if (!read.ok) return { name: 'events', status: 'down', detail: read.detail }
  const { dead, retryable, shown, waiting } = read.value
  if (dead === 0) {
    return { name: 'events', status: 'ok', detail: `none dead, ${waiting} waiting to retry` }
  }
  const named = shown.map((e) => `seq ${e.seq} ${e.event.type} ${e.event.id}`)
  if (dead > shown.length) named.push(`${dead - shown.length} more`)
  const past = dead - retryable
  const hint =
    retryable === 0
      ? 'all past retention, cannot be retried'
      : `fix the cause, then nymbal events retry <seq> or --all${past > 0 ? ` (${past} past retention cannot be retried)` : ''}`
  return {
    name: 'events',
    status: 'degraded',
    detail: `${dead} dead: ${named.join(', ')}; ${waiting} waiting to retry; ${hint}`,
  }
}

function fromReport(name: string, what: string, report: HealthReport): DiagnosisCheck {
  return { name, status: report.status, detail: described(what, report.detail) }
}

/** Where the assistant sends its requests, by the host's name alone (no lookup). */
function placeOf(hostname: string): 'this machine' | 'your network' | 'remote' {
  const name = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (name.includes(':')) {
    if (name === '::1') return 'this machine'
    const first = name.startsWith('::') ? 0 : parseInt(name.split(':')[0]!, 16)
    if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80) return 'your network'
    return 'remote'
  }
  const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(name)?.slice(1).map(Number)
  if (octets !== undefined) {
    const [a, b] = octets as [number, number]
    if (a === 127 || name === '0.0.0.0') return 'this machine'
    if (
      a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b <= 127)
    ) {
      return 'your network'
    }
    return 'remote'
  }
  if (name === 'localhost' || name.endsWith('.localhost')) return 'this machine'
  if (!name.includes('.') || /\.(local|internal|lan|home\.arpa)$/.test(name)) return 'your network'
  return 'remote'
}

/** `nymbal doctor`'s disclosure of the assistant's AI host and what of a customer's data goes there; always ok. */
function aiHostCheck(config: NymbalConfig, provider: string, adapter: unknown): DiagnosisCheck {
  const name = 'ai host'
  if (adapter === null) return { name, status: 'ok', detail: `${provider}: the assistant is off` }
  const endpoint = (adapter as { endpoint?: unknown }).endpoint
  if (typeof endpoint !== 'string') {
    return {
      name,
      status: 'ok',
      detail: `${provider}: its adapter does not say where it sends requests`,
    }
  }
  const url = URL.parse(endpoint)
  if (url === null || url.host === '') {
    return { name, status: 'degraded', detail: `${provider}: its endpoint is not a URL` }
  }
  const assistant = (config.agents as Partial<NymbalConfig['agents']> | undefined)?.assistant
  const mask: readonly string[] = assistant?.mask ?? DEFAULT_ASSISTANT_MASK
  const listed = ASSISTANT_MASK_FIELDS.filter((field) => mask.includes(field))
  const data =
    assistant?.customerData === false
      ? 'customer data off'
      : listed.length === 0
        ? 'customer fields sent as they are'
        : `customer fields masked: ${listed.join(', ')}; ${listed.includes('name') ? '' : 'names, '}city and notes sent`
  return { name, status: 'ok', detail: `${url.host} (${placeOf(url.hostname)}): ${data}` }
}
