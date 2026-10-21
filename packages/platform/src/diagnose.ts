import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { nymbalConfigSchema, type NymbalConfig } from '@nymbalhq/config'
import {
  boundedHealthCheck,
  connectionSecrets,
  displayUrl,
  errorText,
  HEALTH_CHECK_TIMEOUT_MS,
  type CommerceSlot,
  type DocumentStoreAdapter,
  type HealthReport,
  type HealthStatus,
  type Logger,
  type Slot,
} from '@nymbalhq/types'
import { importProviderPackage, PROVIDER_PACKAGES } from './adapters/loader.js'
import {
  checkInjectedSlot,
  COMMERCE_SLOTS,
  resolvePaymentsAdapter,
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
import { buildRepositories } from './repositories/index.js'

/** `ok` is a check with no health semantics (config, a package, migrations); the rest are a health report's. */
export type DiagnosisStatus = HealthStatus | 'ok'

export interface DiagnosisCheck {
  name: string
  status: DiagnosisStatus
  detail: string
}

export interface DiagnosisReport {
  checks: DiagnosisCheck[]
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
    close: async () => {},
  }
}

/** A line's detail: what was checked (a provider, and where it connects), then what the check said. */
function described(what: string, detail: string | undefined): string {
  return detail === undefined || detail === '' ? what : `${what}: ${detail}`
}

function notChecked(prerequisite: string): string {
  return `not checked: ${prerequisite} down`
}

/**
 * Checks a project without changing it: its config, the packages its providers live in, the command store and its
 * migrations, and the health of every commerce slot and primitive. It builds what `createApp` builds, through the same
 * registry and constructors, and nothing more: no warm-up, no relay, no sweeper, no migrator, no seed, and no
 * primitive's `initialize()`. The command store is opened read-only. Every connection is closed before it returns.
 */
export async function diagnose(
  input: NymbalConfig,
  options: DiagnoseOptions = {},
): Promise<DiagnosisReport> {
  const parsed = nymbalConfigSchema.safeParse(input)
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.length > 0 ? issue.path.join('.') : '<root>'}: ${issue.message}`)
      .join('; ')
    return { checks: [{ name: 'config', status: 'down', detail }] }
  }
  const config = parsed.data
  const timeoutMs = options.timeoutMs ?? HEALTH_CHECK_TIMEOUT_MS
  const env = options.env ?? process.env
  const logger = options.logger ?? createLogger({ base: { store: config.store.name } })
  const injected = options.adapters ?? {}
  const infrastructure = config.infrastructure
  const providers: Record<Slot, string> = {
    ...(Object.fromEntries(COMMERCE_SLOTS.map((s) => [s, config.commerce[s].provider])) as Record<
      CommerceSlot,
      string
    >),
    documentStore: infrastructure.documentStore,
    eventBus: infrastructure.eventBus,
    media: infrastructure.media,
    security: config.security.adapter,
  }

  const packages: DiagnosisCheck[] = []
  for (const slot of [...COMMERCE_SLOTS, ...PRIMITIVES]) {
    const entry = PROVIDER_PACKAGES[slot]?.[providers[slot]]
    if (entry === undefined) continue
    const found = await within(timeoutMs, () =>
      importProviderPackage(slot, providers[slot], env),
    )
    packages.push({
      name: `package ${slot}`,
      status: found.ok ? 'ok' : 'down',
      detail: found.ok ? entry.package : found.detail,
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
        : { name: 'migrations', status: 'ok', detail: `${state.value.applied} applied, none pending` }
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
  if (infrastructure.documentStore === 'postgres-jsonb' && commandStore === undefined) {
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

  const slots: DiagnosisCheck[] = []
  const adapterLogger = logger.child({ layer: 'adapter' })
  const builders = slotBuilders({
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
  })
  for (const slot of COMMERCE_SLOTS) {
    const provider = providers[slot]
    const adapter = await within(timeoutMs, async (): Promise<Checkable | null> => {
      checkInjectedSlot(config, slot, injected)
      return slot === 'payments'
        ? resolvePaymentsAdapter(config, adapterLogger, injected)
        : builders[slot]()
    })
    if (!adapter.ok) {
      slots.push({ name: `slot ${slot}`, status: 'down', detail: described(provider, adapter.detail) })
    } else if (adapter.value === null) {
      slots.push({ name: `slot ${slot}`, status: 'ok', detail: provider })
    } else {
      slots.push(fromReport(`slot ${slot}`, provider, await health(adapter.value)))
    }
  }

  const primitives: DiagnosisCheck[] = []
  for (const name of PRIMITIVES) {
    const primitive = built[name]
    if (primitive === undefined) {
      primitives.push({ name: `primitive ${name}`, status: 'down', detail: primitiveFailures[name] ?? '' })
    } else {
      primitives.push(fromReport(`primitive ${name}`, subject(name), await health(primitive)))
    }
  }

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
  ].map((check) => ({
    ...check,
    detail: secrets.reduce((text, secret) => text.split(secret).join('***'), check.detail),
  }))
  return { checks }
}

function fromReport(name: string, what: string, report: HealthReport): DiagnosisCheck {
  return { name, status: report.status, detail: described(what, report.detail) }
}
