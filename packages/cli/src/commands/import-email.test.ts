import { createRequire } from 'node:module'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { cliEnv, REPO_ROOT, runCli } from '../../../../tests/support/doctor.js'
import { workspace } from '../../../../tests/support/project.js'
import { fakeSmtpServer, type FakeSmtpServer } from '../../../../tests/support/smtp-server.js'
import { storeConfig, storeProject, type StoreProject } from '../../../../tests/support/start.js'
import {
  fixture,
  startWooCommerceServer,
  type WooCommerceServer,
} from '../../../../tests/support/woocommerce-server.js'

// `nymbal import` emails no one: the built CLI (`pnpm build` first) imports customers and orders from the WooCommerce
// fixture server into a fresh SQLite store whose email provider is SMTP to a server in this process, once with the
// default --gdpr and once with --no-gdpr, and the server is asked to deliver nothing, though every customer is imported.

const require = createRequire(join(REPO_ROOT, 'packages', 'platform', 'package.json'))
const BetterSqlite3 = require('better-sqlite3') as new (
  path: string,
  options?: { readonly?: boolean },
) => {
  prepare(sql: string): { get(): unknown }
  close(): void
}

function customerRows(dbPath: string): number {
  const db = new BetterSqlite3(dbPath, { readonly: true })
  try {
    return (db.prepare('SELECT count(*) AS n FROM customers').get() as { n: number }).n
  } finally {
    db.close()
  }
}

let woo: WooCommerceServer
let smtp: FakeSmtpServer
const projects: StoreProject[] = []

const customers = [1, 2, 3].map((id) => {
  const email = `shopper${id}@example.com`
  const address = {
    first_name: `First${id}`,
    last_name: `Last${id}`,
    company: '',
    address_1: `${id} Mill Lane`,
    address_2: '',
    city: 'York',
    state: 'yorkshire',
    postcode: `YO${id} 1AA`,
    country: 'GB',
    phone: '',
  }
  return {
    id,
    email,
    first_name: `First${id}`,
    last_name: `Last${id}`,
    username: `shopper${id}`,
    billing: { ...address, email },
    shipping: address,
    meta_data: [],
    date_created: '2024-01-15T10:00:00',
  }
})

beforeAll(async () => {
  smtp = await fakeSmtpServer()
  woo = await startWooCommerceServer({
    imagesPerProduct: 1,
    customers,
    orders: fixture('orders').map((o, i) => ({ ...o, customer_id: (i % customers.length) + 1 })),
  })
})

afterAll(async () => {
  await woo?.close()
  await smtp?.close()
  for (const p of projects.splice(0)) p.remove()
})

/** A store project on SQLite whose email goes by SMTP to the fake server. */
function smtpProject(): StoreProject {
  const config = storeConfig()
  config['commerce'] = {
    ...(config['commerce'] as Record<string, unknown>),
    email: {
      provider: 'smtp',
      config: {
        from: 'shop@import.test',
        smtp: { host: '127.0.0.1', port: smtp.port, secure: false },
      },
    },
  }
  const project = storeProject(config, workspace('@nymbalhq/email-smtp'))
  projects.push(project)
  return project
}

describe('AC-5: nymbal import sends no email', () => {
  it('AC-5: importing customers and orders through the built CLI, with the default --gdpr and again with --no-gdpr into a fresh store, exits 0 and the SMTP server receives no message', async () => {
    const runs = [[], ['--no-gdpr']]
    const outcome: unknown[] = []
    for (const gdprFlag of runs) {
      const project = smtpProject()
      const dbPath = join(project.dir, 'nymbal.db')
      const env = cliEnv({ NYMBAL_SQLITE_PATH: dbPath })
      const migrated = await runCli(['migrate'], { cwd: project.dir, env, timeoutMs: 120_000 })
      expect(migrated.code, migrated.out.slice(-3000)).toBe(0)
      const sentBefore = smtp.messages.length

      const imported = await runCli(
        [
          'import',
          '--source',
          'woocommerce',
          '--url',
          woo.url,
          '--key',
          'k',
          '--secret',
          's',
          '--entities',
          'customers,orders',
          '--no-ai',
          ...gdprFlag,
        ],
        { cwd: project.dir, env, timeoutMs: 120_000 },
      )

      outcome.push({
        run: gdprFlag.join(' ') || '--gdpr',
        code: imported.code,
        customersInStore: customerRows(dbPath),
        delivered: smtp.recipients.slice(sentBefore).flat(),
      })
      expect(imported.code, imported.out.slice(-3000)).toBe(0)
    }

    expect(outcome).toEqual(
      runs.map((flag) => ({
        run: flag.join(' ') || '--gdpr',
        code: 0,
        customersInStore: customers.length,
        delivered: [],
      })),
    )
  }, 300_000)
})
