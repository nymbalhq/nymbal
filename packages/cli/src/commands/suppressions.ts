import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineCommand } from 'citty'
import {
  createCommandStore,
  createEmailSuppressionRepository,
  normaliseEmail,
  sqliteFile,
  type CommandStore,
  type EmailSuppressionRepository,
} from '@nymbalhq/platform'
import { errorText } from '@nymbalhq/types'
import { loadProject } from '../utils/project.js'

/** A bad argument or a missing store, said in the user's terms: exit 2, or 1 when the address is not suppressed. */
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

function addressOf(argument: string | undefined): string {
  const email = normaliseEmail(argument ?? '')
  if (!email.includes('@')) {
    throw new SuppressionsError(`"${argument ?? ''}" is not an email address`)
  }
  return email
}

/** Reads on a read-only open: a writable SQLite open changes the file even when nothing is written. */
async function reading<T>(
  read: (repo: EmailSuppressionRepository, store: CommandStore) => Promise<T>,
): Promise<T> {
  const reader = await openStore(false)
  try {
    return await read(createEmailSuppressionRepository(reader), reader)
  } finally {
    await reader.close()
  }
}

const write = (stream: NodeJS.WriteStream, text: string): Promise<void> =>
  new Promise<void>((done) => stream.write(text, () => done()))

const day = (createdAt: string): string => createdAt.slice(0, 10)

async function show(argument: string | undefined): Promise<void> {
  const email = addressOf(argument)
  const suppression = await reading((repo, store) => store.read((tx) => repo.find(tx, email)))
  if (suppression === null) throw new SuppressionsError(`${email} is not suppressed`, 1)
  await write(
    process.stdout,
    `${email} is suppressed (${suppression.reason}, ${day(suppression.createdAt)})\n`,
  )
}

async function list(limitArgument: string | undefined): Promise<void> {
  const text = limitArgument ?? '100'
  const limit = Number(text)
  if (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(limit)) {
    throw new SuppressionsError(`--limit must be a whole number of 1 or more, not "${text}"`)
  }
  const page = await reading((repo, store) => store.read((tx) => repo.list(tx, { limit })))
  if (page.rows.length === 0) {
    await write(process.stdout, 'no suppressed addresses\n')
    return
  }
  await write(
    process.stdout,
    page.rows.map((row) => `${row.email}  ${row.reason}  ${day(row.createdAt)}\n`).join(''),
  )
  if (page.total > page.rows.length) {
    await write(
      process.stderr,
      `${page.rows.length} of ${page.total} shown: --limit ${page.total} lists all\n`,
    )
  }
}

async function clear(argument: string | undefined): Promise<void> {
  const email = addressOf(argument)
  const notSuppressed = new SuppressionsError(`${email} is not suppressed`, 1)

  const suppression = await reading((repo, store) => store.read((tx) => repo.find(tx, email)))
  if (suppression === null) throw notSuppressed

  const writer = await openStore(true)
  try {
    const suppressions = createEmailSuppressionRepository(writer)
    if (!(await writer.transaction((tx) => suppressions.clear(tx, email)))) throw notSuppressed
  } finally {
    await writer.close()
  }
  await write(
    process.stdout,
    `cleared ${email} (${suppression.reason}, ${day(suppression.createdAt)})\n`,
  )
}

/** Runs a subcommand, its errors said on stderr as the exit code they carry. */
async function reported(run: () => Promise<void>): Promise<void> {
  try {
    await run()
  } catch (error) {
    process.stderr.write(`nymbal suppressions: ${errorText(error)}\n`)
    process.exitCode = error instanceof SuppressionsError ? error.exitCode : 2
  }
}

const showCommand = defineCommand({
  meta: { name: 'show', description: 'Say whether one address is suppressed, why and since when' },
  args: {
    email: { type: 'positional', required: false, description: 'The address to look up' },
  },
  run: ({ args }) => reported(() => show(args.email)),
})

const listCommand = defineCommand({
  meta: { name: 'list', description: 'List the suppressed addresses, newest first' },
  args: {
    limit: { type: 'string', description: 'How many to list (default 100)' },
  },
  run: ({ args }) => reported(() => list(args.limit)),
})

const clearCommand = defineCommand({
  meta: {
    name: 'clear',
    description: 'Take one address off the email suppression list, so it is mailed again',
  },
  args: {
    email: { type: 'positional', required: false, description: 'The address to clear' },
  },
  run: ({ args }) => reported(() => clear(args.email)),
})

export const suppressionsCommand = defineCommand({
  meta: { name: 'suppressions', description: 'Manage the email suppression list' },
  subCommands: { show: showCommand, list: listCommand, clear: clearCommand },
})
