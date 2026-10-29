#!/usr/bin/env node
// e2e-server.mjs -- <command…>: runs a server for the E2E suite so that its shutdown path runs, and a hang in it is
// seen. SIGTERM and SIGINT are forwarded to the child; a child still alive NYMBAL_E2E_SHUTDOWN_MS (default 5000)
// later is recorded in reports/e2e-shutdown.json ({ command, pid, waitedMs }) and SIGKILLed. The gate fails an E2E
// step that leaves the file behind. The wait must stay below Playwright's gracefulShutdown.timeout
// (tests/e2e/playwright.config.ts), or Playwright kills the process group before the file is written.
// It also gives the run stores of its own, as Playwright gives it a fresh SQLite file: with NYMBAL_COMMAND_STORE=postgres
// it creates nymbal_e2e_<stamp> beside the DATABASE_URL database and points DATABASE_URL at it; with a Redis document
// store or bus it sets NYMBAL_REDIS_PREFIX=e2e-<stamp>. Both are removed when the server exits. With
// NYMBAL_E2E_STORE_ENV_FILE set it writes the store variables the server starts with there, as JSON, so a journey can
// run the CLI against the same store (`nymbal replay`); the file is removed with the stores.
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { constants } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEFAULT_SHUTDOWN_MS = 5000
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const REPORT = join(REPO, 'reports', 'e2e-shutdown.json')
// The SDKs come from the packages that depend on them: the repository root has neither.
const pg = () => createRequire(join(REPO, 'packages/platform/package.json'))('pg')
const ioredis = () =>
  createRequire(join(REPO, 'packages/adapters/event-bus/redis-streams/package.json'))('ioredis')

const args = process.argv.slice(2)
const command = args[0] === '--' ? args.slice(1) : args
if (command.length === 0) {
  process.stderr.write('usage: e2e-server.mjs -- <command…>\n')
  process.exit(2)
}
const raw = process.env.NYMBAL_E2E_SHUTDOWN_MS
const waitMs = raw === undefined || raw === '' ? DEFAULT_SHUTDOWN_MS : Number(raw)
if (!Number.isInteger(waitMs) || waitMs <= 0) {
  process.stderr.write(
    `e2e-server: NYMBAL_E2E_SHUTDOWN_MS must be a positive integer, not "${raw}"\n`,
  )
  process.exit(2)
}

const env = { ...process.env }
const stamp = `${Date.now()}_${process.pid}`
const teardown = []

async function onPostgres(serverUrl, sql) {
  const maintenance = new URL(serverUrl)
  maintenance.pathname = '/postgres'
  const client = new (pg().Client)({ connectionString: maintenance.toString() })
  await client.connect()
  try {
    await client.query(sql)
  } finally {
    await client.end()
  }
}

if (env.NYMBAL_COMMAND_STORE === 'postgres' && env.DATABASE_URL) {
  const database = `nymbal_e2e_${stamp}`
  const serverUrl = env.DATABASE_URL
  await onPostgres(serverUrl, `CREATE DATABASE "${database}"`)
  const url = new URL(serverUrl)
  url.pathname = `/${database}`
  env.DATABASE_URL = url.toString()
  teardown.push(() => onPostgres(serverUrl, `DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`))
}

if (
  (env.NYMBAL_DOCUMENT_STORE === 'redis' || env.NYMBAL_EVENT_BUS === 'redis-streams') &&
  env.REDIS_URL
) {
  const prefix = `e2e-${stamp}`
  const redisUrl = env.REDIS_URL
  env.NYMBAL_REDIS_PREFIX = prefix
  teardown.push(async () => {
    const { Redis } = ioredis()
    const client = new Redis(redisUrl, { lazyConnect: true })
    await client.connect()
    try {
      let cursor = '0'
      do {
        const [next, keys] = await client.scan(cursor, 'MATCH', `${prefix}:*`, 'COUNT', 1000)
        if (keys.length > 0) await client.del(...keys)
        cursor = next
      } while (cursor !== '0')
    } finally {
      client.disconnect()
    }
  })
}

/** What selects the server's store: the variables the CLI reads to open the same one. */
const STORE_VARIABLES = [
  'NYMBAL_COMMAND_STORE',
  'NYMBAL_DOCUMENT_STORE',
  'NYMBAL_EVENT_BUS',
  'NYMBAL_SQLITE_PATH',
  'DATABASE_URL',
  'REDIS_URL',
  'NYMBAL_REDIS_PREFIX',
]
const storeEnvFile = env.NYMBAL_E2E_STORE_ENV_FILE
if (storeEnvFile) {
  const recorded = Object.fromEntries(
    STORE_VARIABLES.filter((name) => env[name] !== undefined).map((name) => [name, env[name]]),
  )
  writeFileSync(storeEnvFile, `${JSON.stringify(recorded, null, 2)}\n`)
  teardown.push(async () => rmSync(storeEnvFile, { force: true }))
}

/** Removes the run's stores; a failure is reported and does not hide the server's own exit status. */
async function removeStores() {
  for (const remove of teardown.splice(0)) {
    try {
      await remove()
    } catch (error) {
      process.stderr.write(`e2e-server: could not remove a store of this run: ${error.message}\n`)
    }
  }
}

const child = spawn(command[0], command.slice(1), { stdio: 'inherit', env })
let deadline

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    child.kill(signal)
    if (deadline !== undefined) return
    const sentAt = Date.now()
    deadline = setTimeout(() => {
      mkdirSync(dirname(REPORT), { recursive: true })
      const record = { command: command.join(' '), pid: child.pid, waitedMs: Date.now() - sentAt }
      writeFileSync(REPORT, `${JSON.stringify(record)}\n`)
      process.stderr.write(
        `e2e-server: ${record.command} (pid ${record.pid}) outlived ${signal} by ${record.waitedMs} ms; killed\n`,
      )
      child.kill('SIGKILL')
    }, waitMs)
  })
}

child.on('error', async (error) => {
  process.stderr.write(`e2e-server: cannot start ${command[0]}: ${error.message}\n`)
  await removeStores()
  process.exit(1)
})
child.on('exit', async (code, signal) => {
  if (deadline !== undefined) clearTimeout(deadline)
  await removeStores()
  process.exit(code ?? 128 + (constants.signals[signal] ?? 1))
})
