import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Slot } from '../../packages/types/src/index'

// The first-party adapters by slot: the ones that moved (where each lived, where it lives now and its name), every one
// registry/adapters.json lists, and the workspace as pnpm reads it from the disk. This module imports nothing from the
// workspace expander, so the tests built on it judge that expander instead of trusting it.

export const ROOT = fileURLToPath(new URL('../../', import.meta.url))

/** A scoped name assembled from parts, so the retired names never appear literally in a tracked file. */
const scoped = (...parts: string[]): string => ['@nymbalhq', '/', ...parts].join('')

export interface MovedAdapter {
  /** The directory it had before it moved. */
  from: string
  /** The config's slot key, camel case as in the schema. */
  slot: Slot
  provider: string
  /** Its directory now, `packages/adapters/<slotFolder(slot)>/<provider>`. */
  dir: string
  /** Its package name now. */
  name: string
  /** The name it published under before, for the nine that were renamed. */
  retired?: string
  /** Its test files, relative to the package, and the Vitest project that runs each (before the move and after). */
  tests: ReadonlyArray<readonly [file: string, project: string]>
}

/** The Vitest project that runs a package's tests: the store packages need Redis or Postgres. */
const projectOf = (slot: Slot): string =>
  slot === 'documentStore' || slot === 'eventBus' ? 'integration-stores' : 'adapters'

/**
 * The twelve first-party adapters. Their test files are the ones each package had at the base, plus
 * the SES provider's, each run by the project it ran in before the move.
 */
export const MOVED_ADAPTERS: readonly MovedAdapter[] = (
  [
    {
      from: 'packages/adapter-stripe',
      slot: 'payments',
      provider: 'stripe',
      dir: 'packages/adapters/payments/stripe',
      name: '@nymbalhq/payments-stripe',
      retired: scoped('adapter-', 'stripe'),
      tests: ['src/stripe-adapter.test.ts'],
    },
    {
      from: 'packages/adapter-smtp',
      slot: 'email',
      provider: 'smtp',
      dir: 'packages/adapters/email/smtp',
      name: '@nymbalhq/email-smtp',
      retired: scoped('adapter-', 'smtp'),
      tests: [],
    },
    {
      from: 'packages/adapter-mailgun',
      slot: 'email',
      provider: 'mailgun',
      dir: 'packages/adapters/email/mailgun',
      name: '@nymbalhq/email-mailgun',
      retired: scoped('adapter-', 'mailgun'),
      tests: ['src/health.test.ts', 'src/receive-webhook.test.ts'],
    },
    {
      from: 'packages/adapter-resend',
      slot: 'email',
      provider: 'resend',
      dir: 'packages/adapters/email/resend',
      name: '@nymbalhq/email-resend',
      retired: scoped('adapter-', 'resend'),
      tests: ['src/health.test.ts', 'src/receive-webhook.test.ts'],
    },
    {
      from: 'packages/adapter-ses',
      slot: 'email',
      provider: 'ses',
      dir: 'packages/adapters/email/ses',
      name: '@nymbalhq/email-ses',
      retired: scoped('adapter-', 'ses'),
      tests: ['src/health.test.ts', 'src/receive-webhook.test.ts', 'src/subscription.test.ts'],
    },
    {
      from: 'packages/adapter-anthropic',
      slot: 'ai',
      provider: 'anthropic',
      dir: 'packages/adapters/ai/anthropic',
      name: '@nymbalhq/ai-anthropic',
      retired: scoped('adapter-', 'anthropic'),
      tests: [],
    },
    {
      from: 'packages/adapter-easypost',
      slot: 'shipping',
      provider: 'easypost',
      dir: 'packages/adapters/shipping/easypost',
      name: '@nymbalhq/shipping-easypost',
      retired: scoped('adapter-', 'easypost'),
      tests: ['src/adapter.test.ts', 'src/health.test.ts', 'src/receive-webhook.test.ts'],
    },
    {
      from: 'packages/doc-store-redis',
      slot: 'documentStore',
      provider: 'redis',
      dir: 'packages/adapters/document-store/redis',
      name: '@nymbalhq/document-store-redis',
      retired: scoped('doc-store-', 'redis'),
      tests: ['src/contract.test.ts'],
    },
    {
      from: 'packages/doc-store-postgres-jsonb',
      slot: 'documentStore',
      provider: 'postgres-jsonb',
      dir: 'packages/adapters/document-store/postgres-jsonb',
      name: '@nymbalhq/document-store-postgres-jsonb',
      retired: scoped('doc-store-', 'postgres-jsonb'),
      tests: ['src/contract.test.ts'],
    },
    {
      from: 'packages/event-bus-redis-streams',
      slot: 'eventBus',
      provider: 'redis-streams',
      dir: 'packages/adapters/event-bus/redis-streams',
      name: '@nymbalhq/event-bus-redis-streams',
      tests: ['src/contract.test.ts', 'src/redis-streams-event-bus.test.ts'],
    },
    {
      from: 'packages/media-s3',
      slot: 'media',
      provider: 's3',
      dir: 'packages/adapters/media/s3',
      name: '@nymbalhq/media-s3',
      tests: [],
    },
    {
      from: 'packages/security-cloudflare',
      slot: 'security',
      provider: 'cloudflare',
      dir: 'packages/adapters/security/cloudflare',
      name: '@nymbalhq/security-cloudflare',
      tests: [
        'src/apply.test.ts',
        'src/cache-rule.test.ts',
        'src/desired-rules.test.ts',
        'src/drift.test.ts',
        'src/token-scopes.test.ts',
        'src/validate.test.ts',
      ],
    },
  ] as const
).map(
  (a): MovedAdapter => ({
    ...a,
    tests: a.tests.map((file) => [file, projectOf(a.slot)] as const),
  }),
)

/** The nine retired names. */
export const RETIRED_NAMES: readonly string[] = MOVED_ADAPTERS.flatMap((a) =>
  a.retired === undefined ? [] : [a.retired],
)

/** A first-party adapter: its slot, provider, directory and package name. */
export type FirstPartyAdapter = Pick<MovedAdapter, 'slot' | 'provider' | 'dir' | 'name'>

export interface RegistryEntry {
  package: string
  /** The slot as package names and folders spell it: `document-store`. */
  slot: string
  provider: string
  tier: string
}

/** registry/adapters.json, as far as these tests read it. */
export interface Registry {
  adapters: RegistryEntry[]
}

/** A slot folder back to the config's slot key: `document-store` is `documentStore`. */
const slotKey = (folder: string): Slot =>
  folder.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()) as Slot

/**
 * Every first-party adapter, as registry/adapters.json lists it: the one hand-kept list, so adding an adapter edits no
 * test. Each is expected at its convention home, `packages/adapters/<slot folder>/<provider>`.
 */
export function firstPartyAdapters(registry: Registry): FirstPartyAdapter[] {
  return registry.adapters
    .filter((e) => e.tier === 'first-party')
    .map((e) => ({
      slot: slotKey(e.slot),
      provider: e.provider,
      dir: `packages/adapters/${e.slot}/${e.provider}`,
      name: e.package,
    }))
}

export const FIRST_PARTY_ADAPTERS: readonly FirstPartyAdapter[] = firstPartyAdapters(
  JSON.parse(readFileSync(join(ROOT, 'registry', 'adapters.json'), 'utf8')) as Registry,
)

/**
 * Where the registry's first-party adapters and the workspace disagree, one line per adapter, naming its package and
 * directory: an entry with no member at its home under its name, and a member under packages/adapters/ no entry lists.
 */
export function registryDisagreements(
  listed: readonly FirstPartyAdapter[],
  members: ReadonlyArray<Pick<PnpmMember, 'name' | 'dir'>>,
): string[] {
  const byDir = new Map(members.map((m) => [m.dir, m.name]))
  const homes = new Set(listed.map((a) => a.dir))
  return [
    ...listed
      .filter((a) => byDir.get(a.dir) !== a.name)
      .map(
        (a) =>
          `${a.name} (${a.dir}): registry/adapters.json lists it, but ${byDir.has(a.dir) ? `the member there is ${byDir.get(a.dir)}` : 'no workspace member is there'}`,
      ),
    ...members
      .filter((m) => m.dir.startsWith('packages/adapters/') && !homes.has(m.dir))
      .map((m) => `${m.name} (${m.dir}): a workspace adapter registry/adapters.json does not list`),
  ]
}

export const ADAPTER_NAMES: readonly string[] = FIRST_PARTY_ADAPTERS.map((a) => a.name)

export const adapterNamed = (name: string): MovedAdapter => {
  const found = MOVED_ADAPTERS.find((a) => a.name === name)
  if (found === undefined) throw new Error(`no moved adapter is named ${name}`)
  return found
}

export interface PnpmMember {
  name: string
  /** Relative to the repository root, posix separators; '' for the root. */
  dir: string
  private: boolean
}

let listed: PnpmMember[] | undefined

/** Every workspace member pnpm finds on the disk (`pnpm -r list --json --depth -1`), its path made repo-relative. */
export function pnpmMembers(): PnpmMember[] {
  listed ??= (
    JSON.parse(
      execFileSync('pnpm', ['-r', 'list', '--json', '--depth', '-1'], {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
      }),
    ) as Array<{ name?: string; path: string; private?: boolean }>
  ).map((m) => ({
    name: m.name ?? '',
    dir: relative(ROOT, m.path).split('\\').join('/'),
    private: m.private === true,
  }))
  return listed
}

/** The members under `packages/`, by directory, sorted. */
export function pnpmPackageDirs(): string[] {
  return pnpmMembers()
    .map((m) => m.dir)
    .filter((dir) => dir.startsWith('packages/'))
    .sort()
}
