import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineCommand } from 'citty'
import {
  createCommandStore,
  createLogger,
  diffReadModel,
  migrationState,
  openReadModels,
  READ_MODEL_NAMES,
  rebuild,
  rebuildReports,
  sqliteFile,
  type ReadModelDiff,
  type ReadModelName,
  type RebuildReport,
  type ReportRebuild,
} from '@nymbalhq/platform'
import { errorText } from '@nymbalhq/types'
import { loadProject } from '../utils/project.js'
import { resolveMigrations } from './migrate.js'

/** A bad flag, a missing store or a refused model, said in the user's terms. */
class ReplayError extends Error {}

/** The report tables are not a read model: they live in the command store and are rebuilt only when asked for. */
const REPORTS = 'reports'

function modelsOf(to: string | undefined): readonly ReadModelName[] | typeof REPORTS {
  const choices = `${READ_MODEL_NAMES.join(', ')}, ${REPORTS} or all`
  if (to === undefined || to === '') throw new ReplayError(`--to <model> is required: ${choices}`)
  if (to === 'all') return READ_MODEL_NAMES
  if (to === REPORTS) return REPORTS
  const name = READ_MODEL_NAMES.find((n) => n === to)
  if (name === undefined) throw new ReplayError(`--to must be ${choices}, got "${to}"`)
  return [name]
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** One block per model: what was swapped in, with each collection's documents, and any catch-up event that failed. */
export function formatRebuildReport(report: RebuildReport): string {
  const lines: string[] = []
  for (const entry of report) {
    const caught = plural(entry.caughtUpEvents, 'event')
    lines.push(
      entry.failures.length === 0
        ? `${entry.model}: swapped in ${entry.ms} ms, ${caught} caught up`
        : `${entry.model}: swapped in ${entry.ms} ms, but ${plural(entry.failures.length, 'catch-up event')} failed ` +
            '(the model is swapped without them: fix the cause and replay it again)',
    )
    for (const c of entry.collections) lines.push(`  ${c.name} ${c.documents}`)
    for (const f of entry.failures) {
      lines.push(`  failed: seq ${f.seq} ${f.type} (${f.handler}): ${f.error}`)
    }
    if (entry.note !== undefined) lines.push(`  note: ${entry.note}`)
  }
  return lines.join('\n')
}

/** One block per model: per collection, the documents a rebuild would add, change and remove. */
export function formatDiff(diffs: ReadModelDiff[]): string {
  const lines: string[] = []
  for (const diff of diffs) {
    lines.push(`${diff.model} (dry run, nothing written):`)
    if (diff.skipped !== undefined) lines.push(`  skipped: ${diff.skipped}`)
    for (const c of diff.collections) {
      lines.push(`  ${c.name}: ${c.added} added, ${c.changed} changed, ${c.removed} removed`)
    }
  }
  return lines.join('\n')
}

/** The days rebuilt and each report table's rows; a dry run, what each table would gain, change and lose. */
export function formatReportRebuild(report: ReportRebuild, dryRun: boolean): string {
  if (report.heldFrom === null) return 'reports: the event log holds no whole day to rebuild'
  const days = `${report.heldFrom} to ${report.heldTo}`
  if (dryRun) {
    return [
      `reports (dry run, nothing written): ${days}`,
      ...report.tables.map(
        (t) => `  ${t.name}: ${t.added} added, ${t.changed} changed, ${t.removed} removed`,
      ),
    ].join('\n')
  }
  return [
    `reports: rebuilt ${days} from ${plural(report.events, 'event')} in ${report.ms} ms`,
    ...report.tables.map((t) => `  ${t.name} ${t.rows}`),
  ].join('\n')
}

const differs = (diffs: ReadModelDiff[]) =>
  diffs.some((d) => d.collections.some((c) => c.added + c.changed + c.removed > 0))

function write(stream: NodeJS.WriteStream, text: string): Promise<void> {
  return new Promise((done) => stream.write(`${text}\n`, () => done()))
}

type Project = Awaited<ReturnType<typeof loadProject>>

/** The migrations `nymbal migrate` applies here, else those of the platform whose queries this CLI makes. */
function migrationsRoot(projectRoot: string): string {
  const root = resolveMigrations(projectRoot)
  if (existsSync(root)) return root
  return fileURLToPath(new URL('../migrations', import.meta.resolve('@nymbalhq/platform')))
}

/** A schema behind this build fails the rebuild's queries on columns it does not have yet. */
async function refusePendingMigrations(project: Project): Promise<void> {
  const store = createCommandStore(project.config, { readOnly: true })
  try {
    const { pending } = await migrationState(store, {
      migrationsRoot: migrationsRoot(project.projectRoot),
    })
    if (pending > 0) {
      throw new ReplayError(`${plural(pending, 'migration')} pending: run \`nymbal migrate\``)
    }
  } finally {
    await store.close()
  }
}

async function open(project: Project) {
  const { config, adapters } = project
  if (config.infrastructure.commandStore === 'sqlite' && !existsSync(resolve(sqliteFile()))) {
    throw new ReplayError(`no database at ${sqliteFile()}: run \`nymbal migrate\``)
  }
  await refusePendingMigrations(project)
  return openReadModels(config, {
    // The report says what happened; log lines would repeat it.
    logger: createLogger({ level: 'silent', pretty: false }),
    ...(adapters !== undefined && { adapters }),
  })
}

async function replayReports(project: Project, dryRun: boolean): Promise<void> {
  const { config } = project
  const { deps, close } = await open(project)
  try {
    const report = await rebuildReports(
      {
        store: deps.store,
        repos: deps.repos,
        timeZone: config.store.timezone,
        retentionDays: config.events.retentionDays,
      },
      { dryRun },
    )
    await write(process.stdout, formatReportRebuild(report, dryRun))
    const changes = report.tables.reduce((n, t) => n + t.added + t.changed + t.removed, 0)
    process.exitCode = dryRun && changes > 0 ? 1 : 0
  } finally {
    await close()
  }
}

export const replayCommand = defineCommand({
  meta: {
    name: 'replay',
    description:
      'Rebuild a derived read model from the command store and swap it in: catalogue, orders, customers, search, recently-viewed or all. ' +
      '--to reports rebuilds the report figures of the days the event log still holds whole (all leaves them); ' +
      'on SQLite it holds the write lock while it reads the log, so run it with the server stopped or idle; ' +
      'on Postgres writes that count in reports (add to cart, a product view, checkout) wait until it ends',
  },
  args: {
    to: {
      type: 'string',
      description:
        'The read model: catalogue, orders, customers, search, recently-viewed, reports or all',
    },
    'dry-run': {
      type: 'boolean',
      description:
        'Rebuild into memory and count what differs from the live read model; exits 1 if anything does',
      default: false,
    },
  },
  async run({ args }) {
    try {
      const target = modelsOf(args.to)
      const project = await loadProject()
      const { config } = project
      if (target === REPORTS) {
        await replayReports(project, args['dry-run'])
        return
      }
      const names = target
      const shared = names.filter((n) => n !== 'search')
      if (config.infrastructure.documentStore.provider === 'in-memory' && shared.length > 0) {
        throw new ReplayError(
          `the ${shared.join(', ')} read model${shared.length === 1 ? '' : 's'} live in the server's own process ` +
            "(infrastructure.documentStore 'in-memory'), out of reach of this one; a restart of the server rebuilds them. " +
            'With infrastructure.documentStore redis or postgres-jsonb the read models are shared, and replay rebuilds them in ' +
            'place. --to search works here: the native index lives in the command store.',
        )
      }
      const { deps, close } = await open(project)
      try {
        if (args['dry-run']) {
          const diffs: ReadModelDiff[] = []
          for (const name of names) diffs.push(await diffReadModel(name, deps))
          await write(process.stdout, formatDiff(diffs))
          process.exitCode = differs(diffs) ? 1 : 0
          return
        }
        const report = await rebuild(names, deps)
        await write(process.stdout, formatRebuildReport(report))
        process.exitCode = report.some((e) => e.failures.length > 0) ? 2 : 0
      } finally {
        await close()
      }
    } catch (error) {
      await write(process.stderr, `nymbal replay: ${errorText(error)}`)
      process.exitCode = 2
    }
  },
})
