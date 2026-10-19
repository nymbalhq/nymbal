#!/usr/bin/env node
// e2e-server.mjs -- <command…>: runs a server for the E2E suite so that its shutdown path runs, and a hang in it is
// seen. SIGTERM and SIGINT are forwarded to the child; a child still alive NYMBAL_E2E_SHUTDOWN_MS (default 5000)
// later is recorded in reports/e2e-shutdown.json ({ command, pid, waitedMs }) and SIGKILLed. The gate fails an E2E
// step that leaves the file behind. The wait must stay below Playwright's gracefulShutdown.timeout
// (tests/e2e/playwright.config.ts), or Playwright kills the process group before the file is written.
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { constants } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const DEFAULT_SHUTDOWN_MS = 5000
const REPORT = join(dirname(fileURLToPath(import.meta.url)), '..', 'reports', 'e2e-shutdown.json')

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

const child = spawn(command[0], command.slice(1), { stdio: 'inherit' })
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

child.on('error', (error) => {
  process.stderr.write(`e2e-server: cannot start ${command[0]}: ${error.message}\n`)
  process.exit(1)
})
child.on('exit', (code, signal) => {
  if (deadline !== undefined) clearTimeout(deadline)
  process.exit(code ?? 128 + (constants.signals[signal] ?? 1))
})
