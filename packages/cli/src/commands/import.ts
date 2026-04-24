import { defineCommand } from 'citty'
import { intro, outro, text, select, confirm, spinner, isCancel, cancel } from '@clack/prompts'
import * as p from 'picocolors'
import { loadConfig } from '@nymbal/config'
import { createApp } from '@nymbal/platform'
import { runWooCommerceImport, writeReport, type ImportEntity, type ProgressEvent } from '@nymbal/importers'
import { join } from 'node:path'
import { getCliVersion } from '../utils/version.js'

export const importCommand = defineCommand({
  meta: {
    name: 'import',
    description: 'Migrate content from WooCommerce (or other sources) into Nymbal',
  },
  args: {
    source: {
      type: 'string',
      description: 'Import source (woocommerce)',
    },
    url: {
      type: 'string',
      description: 'Store URL (e.g. https://mystore.com)',
    },
    key: {
      type: 'string',
      description: 'WooCommerce Consumer Key (or set WOOCOMMERCE_KEY env var)',
    },
    secret: {
      type: 'string',
      description: 'WooCommerce Consumer Secret (or set WOOCOMMERCE_SECRET env var)',
    },
    entities: {
      type: 'string',
      description: 'Comma-separated list: products,customers,orders,reviews (default: products,customers,orders)',
    },
    ai: {
      type: 'boolean',
      description: 'Enable AI enrichment (default: true)',
      default: true,
    },
    gdpr: {
      type: 'boolean',
      description: 'Anonymise customer PII (default: true)',
      default: true,
    },
    fresh: {
      type: 'boolean',
      description: 'Ignore previous progress and re-import',
      default: false,
    },
    concurrency: {
      type: 'string',
      description: 'Parallel import workers (default: 4)',
    },
  },
  async run({ args }) {
    const { config } = await loadConfig()
    const projectRoot = process.cwd()
    const statePath = join(projectRoot, '.nymbal-migration.json')
    const isTTY = process.stdin.isTTY ?? false

    intro(p.bold('Nymbal Import'))

    // ── Resolve source ────────────────────────────────────────────────────────
    let source = args.source
    if (!source) {
      if (!isTTY) {
        console.error('--source is required (woocommerce)')
        process.exit(1)
      }
      const picked = await select({
        message: 'Source platform?',
        options: [{ value: 'woocommerce', label: 'WooCommerce' }],
      })
      if (isCancel(picked)) { cancel('Import cancelled'); process.exit(0) }
      source = String(picked)
    }
    if (source !== 'woocommerce') {
      console.error(`Unsupported source: ${source}. Only 'woocommerce' is supported.`)
      process.exit(1)
    }

    // ── Resolve credentials ───────────────────────────────────────────────────
    let storeUrl = args.url
    if (!storeUrl) {
      if (!isTTY) { console.error('--url is required'); process.exit(1) }
      const val = await text({ message: 'Store URL?', placeholder: 'https://mystore.com', validate: (v) => v.startsWith('http') ? undefined : 'Must be a URL' })
      if (isCancel(val)) { cancel('Import cancelled'); process.exit(0) }
      storeUrl = String(val)
    }

    let consumerKey = args.key ?? process.env['WOOCOMMERCE_KEY'] ?? ''
    if (!consumerKey) {
      if (!isTTY) { console.error('--key or WOOCOMMERCE_KEY is required'); process.exit(1) }
      const val = await text({ message: 'Consumer Key?', placeholder: 'ck_...' })
      if (isCancel(val)) { cancel('Import cancelled'); process.exit(0) }
      consumerKey = String(val)
    }

    let consumerSecret = args.secret ?? process.env['WOOCOMMERCE_SECRET'] ?? ''
    if (!consumerSecret) {
      if (!isTTY) { console.error('--secret or WOOCOMMERCE_SECRET is required'); process.exit(1) }
      const val = await text({ message: 'Consumer Secret?', placeholder: 'cs_...' })
      if (isCancel(val)) { cancel('Import cancelled'); process.exit(0) }
      consumerSecret = String(val)
    }

    // ── Resolve entity list ───────────────────────────────────────────────────
    let entityList: ImportEntity[]
    if (args.entities) {
      entityList = args.entities.split(',').map((e) => e.trim()) as ImportEntity[]
    } else {
      entityList = ['categories', 'products', 'customers', 'orders']
    }

    const concurrency = parseInt(String(args.concurrency ?? '4'), 10)
    const aiEnabled = args.ai !== false
    const gdprEnabled = args.gdpr !== false

    // ── Bootstrap app ─────────────────────────────────────────────────────────
    const loadSpin = spinner()
    loadSpin.start('Starting platform…')
    const app = await createApp(config, { version: getCliVersion() })
    loadSpin.stop('Platform ready')

    try {
      const report = await runWooCommerceImport(
        {
          credentials: { url: storeUrl, consumerKey, consumerSecret },
          entities: entityList,
          ai: aiEnabled,
          gdpr: gdprEnabled,
          fresh: args.fresh,
          concurrency,
          projectRoot,
          currency: config.store.currency,
          statePath,
        },
        {
          services: app.services,
          repos: app.repos,
          adapters: { ai: app.adapters.ai, reviews: app.adapters.reviews },
          onProgress(event: ProgressEvent) {
            if (event.kind === 'phase') {
              console.log(p.cyan(`  → ${event.phase}`))
            } else if (event.kind === 'progress') {
              const pct = Math.round((event.done / event.total) * 100)
              process.stdout.write(`\r  ${event.entity}: ${event.done}/${event.total} (${pct}%)  `)
              if (event.done === event.total) process.stdout.write('\n')
            } else if (event.kind === 'error') {
              console.log(p.red(`  ✗ ${event.phase} [${event.id}]: ${event.message}`))
            }
          },
        },
      )

      const reportPath = await writeReport(report, projectRoot, config.store.name)

      outro(
        [
          p.green('✓ Import complete'),
          `  Products:   ${report.imported.products}`,
          `  Customers:  ${report.imported.customers}`,
          `  Orders:     ${report.imported.orders}`,
          `  Categories: ${report.imported.categories}`,
          ...(aiEnabled ? [`  AI enriched: ${report.enriched.enriched} products`] : []),
          ...(report.errors.length > 0 ? [p.yellow(`  ⚠ ${report.errors.length} errors — see report`)] : []),
          ``,
          `  Report: ${reportPath}`,
          `  Next:   ${p.bold('nymbal dev')}`,
        ].join('\n'),
      )
    } finally {
      await app.stop()
    }
  },
})
