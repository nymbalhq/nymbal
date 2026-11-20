import { readFile } from 'node:fs/promises'
import type { NymbalConfig } from '@nymbalhq/config'
import {
  acceptLegacyHash,
  createApp,
  createLogger,
  legacyUntilOf,
  legacyWindowOpen,
  newCorrelationId,
  runAsActor,
  runWithCorrelation,
  withoutQueryParams,
  type ImportLegacyPasswordAnswer,
} from '@nymbalhq/platform'
import { ImportStateError, loadState } from '@nymbalhq/importers'
import { getCliVersion } from '../utils/version.js'

export interface PasswordHashImportRun {
  config: NymbalConfig
  /** The WP-CLI export: `email<TAB>hash` per line. */
  file: string
  statePath: string
  dryRun: boolean
}

const DAY_MS = 24 * 60 * 60_000
/** How far ahead the refusal's ready-made date is. */
const SUGGESTED_DAYS = 180
/** The domain a `--gdpr` import gives customers (importers' `anonymisedCustomerEmail`). */
const GDPR_DOMAIN = '@imported.nymbal.local'

type Outcome = Exclude<ImportLegacyPasswordAnswer, 'unsupported'> | 'format' | 'cost' | 'duplicate'

const LABELS: ReadonlyArray<[Outcome, string]> = [
  ['stored', 'stored'],
  ['has-password', 'already have a password'],
  ['unmatched', 'no customer with this email'],
  ['format', 'hash not supported (format)'],
  ['cost', 'hash not supported (cost)'],
  ['duplicate', 'listed more than once'],
]

interface HashLine {
  email: string
  hash: string
}

/** The file's lines: a `user_pass` header, blank lines and a trailing `\r` left out; a line with no tab has no hash. */
function parse(text: string): HashLine[] {
  const lines: HashLine[] = []
  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (line.trim() === '') continue
    const tab = line.indexOf('\t')
    const email = tab === -1 ? line : line.slice(0, tab)
    const hash = tab === -1 ? '' : line.slice(tab + 1)
    if (lines.length === 0 && hash === 'user_pass') continue
    lines.push({ email, hash })
  }
  return lines
}

function refuseWithoutSunset(config: NymbalConfig): void {
  const legacy = config.security.auth.legacy
  if (legacy !== undefined && legacyWindowOpen(legacyUntilOf(legacy.until), new Date())) return
  const ready = new Date(Date.now() + SUGGESTED_DAYS * DAY_MS).toISOString().slice(0, 10)
  console.error(
    [
      legacy === undefined
        ? 'security.auth.legacy.until is not set, so imported password hashes would never be honoured: nothing was stored.'
        : `security.auth.legacy.until (${legacy.until}) has passed, so imported password hashes are no longer honoured: nothing was stored.`,
      `Set the date they stop being honoured (at most 366 days ahead) in nymbal.config.ts, e.g. ${SUGGESTED_DAYS} days from today:`,
      `  security: { auth: { legacy: { until: '${ready}' } } }`,
    ].join('\n'),
  )
  process.exit(1)
}

/**
 * Attaches the WordPress password hashes in an export to the imported customers who have no password yet, until the
 * store's sunset date. It prints counts only: no email or hash from the file reaches the terminal or any file.
 */
export async function runPasswordHashImport(run: PasswordHashImportRun): Promise<void> {
  refuseWithoutSunset(run.config)
  const lines = parse(await readFile(run.file, 'utf8'))
  const maxCost = run.config.security.auth.legacy!.maxCost

  const seen = new Map<string, number>()
  for (const { email } of lines)
    seen.set(email.toLowerCase(), (seen.get(email.toLowerCase()) ?? 0) + 1)
  const counts = new Map<Outcome, number>(LABELS.map(([outcome]) => [outcome, 0]))
  const count = (outcome: Outcome) => counts.set(outcome, counts.get(outcome)! + 1)
  for (const n of seen.values()) if (n > 1) count('duplicate')

  // Counts are the whole output: the store's own logs only when something goes wrong.
  const logger = createLogger({
    level: process.env['LOG_LEVEL'] ?? 'warn',
    base: { store: run.config.store.name },
  })
  const app = await createApp(run.config, { version: getCliVersion(), logger })
  let gdprStore = false
  let failure: string | undefined
  try {
    // One operation, attributed to the import: each hash stored is an audit entry of its own.
    await runWithCorrelation(newCorrelationId('import:password-hashes'), () =>
      runAsActor({ kind: 'import', id: 'woocommerce' }, async () => {
        for (const { email, hash } of lines) {
          if (seen.get(email.toLowerCase())! > 1) continue
          const accepted = acceptLegacyHash('wordpress', hash, maxCost)
          if (!accepted.ok) {
            count(accepted.reason)
            continue
          }
          const answer = await app.services.auth.importLegacyPassword({
            email,
            recipe: 'wordpress',
            hash,
            dryRun: run.dryRun,
          })
          count(answer === 'unsupported' ? 'format' : answer)
        }
      }),
    )
    if (lines.length > 0 && counts.get('unmatched') === lines.length) {
      gdprStore = await importedUnderGdpr(app, run.statePath)
    }
  } catch (err) {
    // A failed statement's error lists the values it bound, emails and hashes from the file among them.
    const clean = withoutQueryParams(err)
    failure = clean instanceof Error ? clean.message : String(clean)
  } finally {
    await app.stop()
  }
  if (failure !== undefined) {
    console.error(`The password hash import stopped: ${failure}`)
    console.error('Any hash stored before it stays stored; running the import again is safe.')
    process.exit(1)
  }

  console.log(run.dryRun ? 'Password hashes (dry run, nothing written):' : 'Password hashes:')
  for (const [outcome, label] of LABELS) console.log(`  ${label}: ${counts.get(outcome)}`)
  if (gdprStore) {
    console.log(
      'No email matched: the customers were imported with --gdpr, so the store holds placeholder addresses no shopper signs in with.',
    )
  }
  console.log(
    'Restart or redeploy the store if you changed security.auth.legacy: the store reads it when it starts.',
  )
  console.log(`Delete ${run.file} now: it holds your customers' password hashes.`)
}

/** Whether the imported customers sit on the `--gdpr` placeholder domain, read from the import's state. */
async function importedUnderGdpr(
  app: Awaited<ReturnType<typeof createApp>>,
  statePath: string,
): Promise<boolean> {
  let state
  try {
    state = await loadState(statePath)
  } catch (err) {
    if (err instanceof ImportStateError) return false
    throw err
  }
  const id = Object.values(state?.wcToNymbalCustomer ?? {})[0]
  if (id === undefined) return false
  const customer = await app.platform.commandStore.read((tx) => app.repos.customer.findById(tx, id))
  return customer?.email.endsWith(GDPR_DOMAIN) ?? false
}
