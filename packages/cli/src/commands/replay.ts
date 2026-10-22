import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineCommand } from 'citty'
import {
  createLogger,
  diffReadModel,
  openReadModels,
  READ_MODEL_NAMES,
  rebuild,
  sqliteFile,
  type ReadModelDiff,
  type ReadModelName,
  type RebuildReport,
} from '@nymbalhq/platform'
import { errorText } from '@nymbalhq/types'
import { loadProject } from '../utils/project.js'

/** A bad flag, a missing store or a refused model, said in the user's terms. */
class ReplayError extends Error {}

function modelsOf(to: string | undefined): readonly ReadModelName[] {
  const choices = `${READ_MODEL_NAMES.join(', ')} or all`
  if (to === undefined || to === '') throw new ReplayError(`--to <model> is required: ${choices}`)
  if (to === 'all') return READ_MODEL_NAMES
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

const differs = (diffs: ReadModelDiff[]) =>
  diffs.some((d) => d.collections.some((c) => c.added + c.changed + c.removed > 0))

function write(stream: NodeJS.WriteStream, text: string): Promise<void> {
  return new Promise((done) => stream.write(`${text}\n`, () => done()))
}

export const replayCommand = defineCommand({
  meta: {
    name: 'replay',
    description:
      'Rebuild a derived read model from the command store and swap it in: catalogue, orders, customers, search or all',
  },
  args: {
    to: {
      type: 'string',
      description: 'The read model: catalogue, orders, customers, search or all',
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
      const names = modelsOf(args.to)
      const { config, adapters } = await loadProject()
      const shared = names.filter((n) => n !== 'search')
      if (config.infrastructure.documentStore === 'in-memory' && shared.length > 0) {
        throw new ReplayError(
          `the ${shared.join(', ')} read model${shared.length === 1 ? '' : 's'} live in the server's own process ` +
            '(documentStore: in-memory), out of reach of this one; a restart of the server rebuilds them. ' +
            'With documentStore redis or postgres-jsonb the read models are shared, and replay rebuilds them in ' +
            'place. --to search works here: the native index lives in the command store.',
        )
      }
      if (config.infrastructure.commandStore === 'sqlite' && !existsSync(resolve(sqliteFile()))) {
        throw new ReplayError(`no database at ${sqliteFile()}: run \`nymbal migrate\``)
      }
      const { deps, close } = await openReadModels(config, {
        // The report says what happened; log lines would repeat it.
        logger: createLogger({ level: 'silent', pretty: false }),
        ...(adapters !== undefined && { adapters }),
      })
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
