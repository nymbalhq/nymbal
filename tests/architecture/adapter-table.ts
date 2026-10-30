import { execFileSync } from 'node:child_process'
import { relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Slot } from '../../packages/types/src/index'

// The first-party adapters by slot: where each lived, where it lives now and its name, and the workspace as pnpm reads
// it from the disk. This module imports nothing from the workspace expander, so the tests built on it judge that
// expander instead of trusting it.

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

/** Every first-party adapter: the twelve that moved, and those added at their convention home since. */
export const FIRST_PARTY_ADAPTERS: readonly FirstPartyAdapter[] = [
  ...MOVED_ADAPTERS,
  {
    slot: 'search',
    provider: 'algolia',
    dir: 'packages/adapters/search/algolia',
    name: '@nymbalhq/search-algolia',
  },
]

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
