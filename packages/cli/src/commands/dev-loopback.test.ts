import { mkdtempSync, rmSync } from 'node:fs'
import { connect } from 'node:net'
import { networkInterfaces, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cliEnv, REPO_ROOT, startDev, type DevRun } from '../../../../tests/support/doctor.js'

// AC-10, the process half: `nymbal dev --api-only` on the repo's config (the schema's host 0.0.0.0) with no
// NYMBAL_JWT_SECRET starts and answers on 127.0.0.1, says once that NYMBAL_JWT_SECRET would open it up, and is not
// reachable on this machine's other addresses. Needs `pnpm build`.

const VARIABLE = 'NYMBAL_JWT_SECRET'

let dirs: string[] = []
let runs: DevRun[] = []

afterEach(async () => {
  for (const run of runs.splice(0)) await run.stop()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** This machine's own IPv4 addresses other than loopback, the ones another machine on its network reaches. */
function externalAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((a) => a !== undefined && !a.internal && a.family === 'IPv4')
    .map((a) => a!.address)
}

/** Whether a TCP connection to `host:port` is accepted, within two seconds. */
function accepts(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port })
    const done = (open: boolean) => {
      socket.destroy()
      resolve(open)
    }
    socket.setTimeout(2000, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

describe('AC-10: nymbal dev with the default secret listens on loopback only', () => {
  it('AC-10: with no NYMBAL_JWT_SECRET and the schema host, dev answers GET /health on 127.0.0.1, prints one line naming NYMBAL_JWT_SECRET, and refuses connections on every other address of this machine', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'nymbal-dev-loopback-'))
    dirs.push(dir)
    const run = await startDev([], {
      cwd: REPO_ROOT,
      env: cliEnv({ NYMBAL_SQLITE_PATH: join(dir, 'nymbal.db'), [VARIABLE]: undefined }),
    })
    runs.push(run)
    const external = externalAddresses()

    const health = await fetch(`${run.base}/health`, { signal: AbortSignal.timeout(5000) })
    const reachable = await Promise.all(external.map((host) => accepts(host, run.port)))
    const naming = run
      .output()
      .split('\n')
      .filter((line) => line.includes(VARIABLE))

    expect(health.status).toBe(200)
    expect(external.map((host, i) => [host, reachable[i]])).toEqual(
      external.map((host) => [host, false]),
    )
    expect(naming, run.output().slice(-3000)).toHaveLength(1)
  }, 90_000)
})
