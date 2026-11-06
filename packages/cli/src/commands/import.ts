import { defineCommand } from 'citty'
import { intro, outro, text, select, spinner, isCancel, cancel } from '@clack/prompts'
import p from 'picocolors'
import { loadProject } from '../utils/project.js'
import { createApp, newCorrelationId, runAsActor, runWithCorrelation } from '@nymbalhq/platform'
import {
  ImportSinceError,
  ImportStateError,
  loadState,
  resolveSince,
  runWooCommerceImport,
  writeReport,
  type ImportEntity,
  type ImportState,
  type ProgressEvent,
  type SinceByEntity,
} from '@nymbalhq/importers'
import { join } from 'node:path'
import { getCliVersion } from '../utils/version.js'
import { runImportPlan } from './import-plan.js'
import { runImportRollback } from './import-rollback.js'

const IMPORT_ENTITIES = ['categories', 'products', 'customers', 'orders', 'reviews'] as const satisfies readonly ImportEntity[]

function printProgress(event: ProgressEvent): void {
  if (event.kind === 'phase') {
    console.log(p.cyan(`  → ${event.phase}`))
  } else if (event.kind === 'progress') {
    const pct = Math.round((event.done / event.total) * 100)
    process.stdout.write(`\r  ${event.entity}: ${event.done}/${event.total} (${pct}%)  `)
    if (event.done >= event.total) process.stdout.write('\n')
  } else if (event.kind === 'error') {
    console.log(p.red(`  ✗ ${event.phase} [${event.id}]: ${event.message}`))
  }
}

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
    'untracked-stock': {
      type: 'string',
      description:
        'Stock for products WooCommerce does not count, when in stock or on backorder (default: 1000)',
    },
    'dry-run': {
      type: 'boolean',
      description:
        'Read the source and write nymbal-import-plan.json and .md (counts, collisions, unmapped fields, estimate); import nothing',
      default: false,
    },
    rollback: {
      type: 'boolean',
      description:
        'Remove every record the imports in this project created, from .nymbal-migration.json; needs no source or credentials',
      default: false,
    },
    yes: {
      type: 'boolean',
      description: 'With --rollback: remove without asking',
      default: false,
    },
    since: {
      type: 'string',
      description:
        'Bring over what changed in WooCommerce since the last finished import (last), a date (2026-10-01, UTC) or a date-time with a zone',
    },
  },
  async run({ args, rawArgs }) {
    if (args.rollback) {
      const since = rawArgs.some((a) => a === '--since' || a.startsWith('--since='))
      const conflicts = [
        ...(args['dry-run'] ? ['--dry-run'] : []),
        ...(since ? ['--since'] : []),
        ...(args.fresh ? ['--fresh'] : []),
      ]
      if (conflicts.length > 0) {
        console.error(`--rollback cannot be combined with ${conflicts.join(', ')}`)
        process.exit(1)
      }
    }
    if (args.since !== undefined && (args.fresh || args['dry-run'])) {
      console.error(`--since cannot be combined with ${args.fresh ? '--fresh' : '--dry-run'}`)
      process.exit(1)
    }

    const { config } = await loadProject()
    const projectRoot = process.cwd()
    const statePath = join(projectRoot, '.nymbal-migration.json')
    const isTTY = process.stdin.isTTY ?? false

    if (args.rollback) {
      intro(p.bold('Nymbal Import rollback'))
      await runImportRollback({ config, statePath, yes: args.yes, isTTY, onProgress: printProgress })
      return
    }

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
      const names = args.entities.split(',').map((e) => e.trim())
      const unknown = names.filter((e) => !(IMPORT_ENTITIES as readonly string[]).includes(e))
      if (unknown.length > 0) {
        console.error(`Unknown entity: ${unknown.join(', ')}. Choose from ${IMPORT_ENTITIES.join(', ')}.`)
        process.exit(1)
      }
      entityList = names as ImportEntity[]
    } else {
      entityList = ['categories', 'products', 'customers', 'orders']
    }

    const concurrency = parseInt(String(args.concurrency ?? '4'), 10)
    const aiEnabled = args.ai !== false
    const gdprEnabled = args.gdpr !== false

    if (args['dry-run']) {
      await runImportPlan({
        config,
        projectRoot,
        statePath,
        credentials: { url: storeUrl, consumerKey, consumerSecret },
        entities: entityList,
        gdpr: gdprEnabled,
        concurrency,
        onProgress: printProgress,
      })
      return
    }

    // A state file that cannot be read holds what earlier runs created: stop before the store is opened.
    let saved: ImportState | null = null
    try {
      saved = await loadState(statePath)
    } catch (err) {
      if (!(err instanceof ImportStateError)) throw err
      console.error(err.message)
      process.exit(1)
    }

    let since: SinceByEntity | undefined
    if (args.since !== undefined) {
      if (saved !== null && saved.phase !== 'done') {
        console.error('The last import has not finished: run nymbal import to finish it, then nymbal import --since.')
        process.exit(1)
      }
      try {
        since = resolveSince(args.since, saved)
      } catch (err) {
        if (!(err instanceof ImportSinceError)) throw err
        console.error(err.message)
        process.exit(1)
      }
    }

    // ── Bootstrap app ─────────────────────────────────────────────────────────
    const loadSpin = spinner()
    loadSpin.start('Starting platform…')
    const app = await createApp(config, { version: getCliVersion() })
    loadSpin.stop('Platform ready')

    try {
      // One run is one operation: every event the import causes carries one id, and every write it makes is the
      // import's, one audit entry per record written.
      const report = await runWithCorrelation(newCorrelationId('import:woocommerce'), () =>
        runAsActor({ kind: 'import', id: 'woocommerce' }, () => runWooCommerceImport(
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
            ...(args['untracked-stock'] !== undefined && {
              untrackedStock: Number(args['untracked-stock']),
            }),
            ...(since !== undefined && { since }),
          },
          {
            services: app.services,
            repos: app.repos,
            adapters: { ai: app.adapters.ai, reviews: app.adapters.reviews },
            media: app.platform.media,
            onProgress: printProgress,
          },
        )),
      )

      const reportPath = await writeReport(report, projectRoot, config.store.name)

      // After a delta, each total says how many of its records this run brought over.
      const isDelta = report.since !== undefined
      const total = (
        entity: ImportEntity,
        map: 'wcToNymbalProduct' | 'wcToNymbalCustomer' | 'wcToNymbalOrder' | 'wcToNymbalCategory',
      ) => {
        const n = report.imported[entity]
        if (!isDelta) return String(n)
        return `${n} (${n - Object.keys(saved?.[map] ?? {}).length} new)`
      }
      outro(
        [
          p.green('✓ Import complete'),
          `  Products:   ${total('products', 'wcToNymbalProduct')}`,
          `  Customers:  ${total('customers', 'wcToNymbalCustomer')}`,
          `  Orders:     ${total('orders', 'wcToNymbalOrder')}`,
          `  Categories: ${total('categories', 'wcToNymbalCategory')}`,
          ...(isDelta
            ? [
                `  Updated products: ${report.updated.products}`,
                `  Changed orders not updated: ${report.changedNotUpdated.orders}`,
              ]
            : []),
          aiEnabled && app.adapters.ai !== null
            ? `  AI enriched: ${report.enriched.enriched} products`
            : `  AI enrichment: off (${aiEnabled ? 'the ai provider is none' : '--no-ai'})`,
          ...(report.errors.length > 0 || report.warnings.length > 0
            ? [p.yellow(`  ⚠ ${report.errors.length} errors, ${report.warnings.length} to review before launch — see report`)]
            : []),
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
