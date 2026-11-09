import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineCommand } from 'citty'
import {
  createCommandStore,
  createEmailSuppressionRepository,
  normaliseEmail,
  sqliteFile,
  type CommandStore,
} from '@nymbalhq/platform'
import { errorText } from '@nymbalhq/types'
import { loadProject } from '../utils/project.js'

/** A bad argument or a missing store, said in the user's terms: exit 2, or 1 when there was nothing to clear. */
class SuppressionsError extends Error {
  exitCode: number
  constructor(message: string, exitCode = 2) {
    super(message)
    this.exitCode = exitCode
  }
}

async function openStore(writable: boolean): Promise<CommandStore> {
  const { config } = await loadProject()
  if (config.infrastructure.commandStore === 'sqlite') {
    const path = sqliteFile()
    if (!existsSync(resolve(path))) {
      throw new SuppressionsError(`no database at ${path}: run \`nymbal migrate\``)
    }
  }
  return createCommandStore(config, { readOnly: !writable })
}

async function clear(argument: string | undefined): Promise<void> {
  const email = normaliseEmail(argument ?? '')
  if (!email.includes('@')) {
    throw new SuppressionsError(`"${argument ?? ''}" is not an email address`)
  }
  const notSuppressed = new SuppressionsError(`${email} is not suppressed`, 1)

  // Decided on a read-only open: a writable SQLite open changes the file even when nothing is cleared.
  const reader = await openStore(false)
  let suppression: { reason: string; createdAt: string } | null
  try {
    const suppressions = createEmailSuppressionRepository(reader)
    suppression = await reader.read((tx) => suppressions.find(tx, email))
  } finally {
    await reader.close()
  }
  if (suppression === null) throw notSuppressed

  const writer = await openStore(true)
  try {
    const suppressions = createEmailSuppressionRepository(writer)
    if (!(await writer.transaction((tx) => suppressions.clear(tx, email)))) throw notSuppressed
  } finally {
    await writer.close()
  }
  const line = `cleared ${email} (${suppression.reason}, ${suppression.createdAt.slice(0, 10)})\n`
  await new Promise<void>((done) => process.stdout.write(line, () => done()))
}

const clearCommand = defineCommand({
  meta: {
    name: 'clear',
    description: 'Take one address off the email suppression list, so it is mailed again',
  },
  args: {
    email: { type: 'positional', required: false, description: 'The address to clear' },
  },
  run: async ({ args }) => {
    try {
      await clear(args.email)
    } catch (error) {
      process.stderr.write(`nymbal suppressions: ${errorText(error)}\n`)
      process.exitCode = error instanceof SuppressionsError ? error.exitCode : 2
    }
  },
})

export const suppressionsCommand = defineCommand({
  meta: { name: 'suppressions', description: 'Manage the email suppression list' },
  subCommands: { clear: clearCommand },
})
