import { createWriteStream, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { once } from 'node:events'
import type { Writable } from 'node:stream'
import { defineCommand } from 'citty'
import {
  auditEntriesInOrder,
  createCommandStore,
  sqliteFile,
  type AuditFilter,
} from '@nymbalhq/platform'
import { errorText } from '@nymbalhq/types'
import { loadProject } from '../utils/project.js'

/** A bad flag or a missing store, said in the user's terms. */
class AuditError extends Error {}

function timeFlag(name: string, value: string | undefined): Date | undefined {
  if (value === undefined) return undefined
  const at = new Date(value)
  if (value.trim() === '' || Number.isNaN(at.getTime())) {
    throw new AuditError(`--${name} must be an ISO 8601 time, got "${value}"`)
  }
  return at
}

async function write(out: Writable, text: string): Promise<void> {
  if (!out.write(text)) await once(out, 'drain')
}

const exportCommand = defineCommand({
  meta: {
    name: 'export',
    description:
      'Print audit entries as NDJSON, oldest first: ids only, no event payloads or customer data',
  },
  args: {
    since: { type: 'string', description: 'Only entries at or after this ISO time' },
    until: { type: 'string', description: 'Only entries before this ISO time' },
    correlation: { type: 'string', description: 'Only the entries of this correlation id' },
    out: { type: 'string', description: 'Write the lines to this file instead of stdout' },
  },
  async run({ args }) {
    try {
      const since = timeFlag('since', args.since)
      const until = timeFlag('until', args.until)
      const filter: AuditFilter = {
        ...(since !== undefined && { since }),
        ...(until !== undefined && { until }),
        ...(args.correlation !== undefined && { correlation: args.correlation }),
      }
      const { config } = await loadProject()
      if (config.infrastructure.commandStore === 'sqlite') {
        const path = sqliteFile()
        if (!existsSync(resolve(path))) {
          throw new AuditError(`no database at ${path}: run \`nymbal migrate\``)
        }
      }
      // Opened read-only, as `nymbal doctor` and `nymbal events` open it: an export never writes the store.
      const store = createCommandStore(config, { readOnly: true })
      const out = args.out === undefined ? process.stdout : createWriteStream(args.out)
      try {
        for await (const entry of auditEntriesInOrder(store, filter)) {
          await write(out, `${JSON.stringify(entry)}\n`)
        }
      } finally {
        await store.close()
        if (out !== process.stdout) {
          out.end()
          await once(out, 'finish')
        }
      }
    } catch (error) {
      process.stderr.write(`nymbal audit: ${errorText(error)}\n`)
      process.exitCode = 2
    }
  },
})

export const auditCommand = defineCommand({
  meta: { name: 'audit', description: 'Read the audit trail' },
  subCommands: { export: exportCommand },
})
