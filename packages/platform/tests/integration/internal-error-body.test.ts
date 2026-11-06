import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { serveKernel, type ServedKernel } from '../support/http.js'
import { createKernel } from '../support/kernel.js'
import { captureLogs, stringsIn, type LogCapture } from '../support/settings.js'
import { shopper } from '../support/shopper.js'

// A route that catches a driver's error answers 500 `internal` / `Internal server error` and logs the error once;
// none of the driver's text reaches the caller. The driver error is real: a trigger on the kernel's own database
// refuses every customer insert with SQLite's own wording, so POST /api/auth/register meets it inside its catch.

const DRIVER_MESSAGE = 'UNIQUE constraint failed: customers.email'

let s: ServedKernel
let logs: LogCapture

beforeAll(async () => {
  logs = captureLogs()
  s = await serveKernel(await createKernel({ dialect: 'sqlite', logger: logs.logger }))
  const db = new Database(s.kernel.target)
  try {
    db.exec(
      `CREATE TRIGGER refuse_customer_insert BEFORE INSERT ON customers BEGIN SELECT RAISE(ABORT, '${DRIVER_MESSAGE}'); END`,
    )
  } finally {
    db.close()
  }
}, 60_000)

afterAll(async () => {
  await s?.stop()
})

describe('AC-18: a route that catches a driver error hides its text', () => {
  it('AC-18: POST /api/auth/register meeting a driver error answers 500 internal / Internal server error, the body holds no part of the driver’s message, and the error log records each such error once', async () => {
    const shop = shopper(s.baseUrl)

    const answers = []
    for (let i = 0; i < 2; i++) {
      answers.push(
        await shop.call('POST', '/api/auth/register', {
          email: `driver-${randomUUID()}@errors.test`,
          password: 'correct-horse-battery',
        }),
      )
    }
    const leaked = answers.flatMap((res) =>
      DRIVER_MESSAGE.split(/[\s:]+/).filter((part) => JSON.stringify(res.body).includes(part)),
    )
    const logged = logs.calls
      .filter((c) => c.level === 'error')
      .filter((c) => stringsIn([c.obj, c.msg ?? '']).some((v) => v.includes(DRIVER_MESSAGE)))

    expect(answers.map((res) => ({ status: res.status, error: res.body.error }))).toEqual(
      answers.map(() => ({
        status: 500,
        error: { code: 'internal', message: 'Internal server error' },
      })),
    )
    expect(leaked).toEqual([])
    expect(logged).toHaveLength(answers.filter((res) => res.status === 500).length)
  })
})
