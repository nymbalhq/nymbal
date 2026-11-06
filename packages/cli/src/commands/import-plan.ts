import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { outro } from '@clack/prompts'
import p from 'picocolors'
import type { NymbalConfig } from '@nymbalhq/config'
import {
  createCategoryRepository,
  createCommandStore,
  createCustomerRepository,
  createOrderRepository,
  createProductRepository,
  createVariantRepository,
  sqliteFile,
  type CommandStore,
  type ReadTx,
} from '@nymbalhq/platform'
import {
  planWooCommerceImport,
  writePlan,
  type ExistingStoreLookup,
  type ImportEntity,
  type ProgressCallback,
  type WooCommerceCredentials,
} from '@nymbalhq/importers'
import { errorText } from '@nymbalhq/types'

export interface ImportPlanRun {
  config: NymbalConfig
  projectRoot: string
  statePath: string
  credentials: WooCommerceCredentials
  entities: ImportEntity[]
  gdpr: boolean
  concurrency: number
  onProgress: ProgressCallback
}

type OpenedStore =
  | { lookup: ExistingStoreLookup; close: () => Promise<void> }
  | { notChecked: string }

/** The store the import would write to (the path `createApp` uses), opened so that no write can land. */
export function openStoreReadOnly(config: NymbalConfig): CommandStore {
  return createCommandStore(config, { readOnly: true })
}

/** The store the import would write to, opened read-only, or why it could not be. */
function openExistingStore(config: NymbalConfig): OpenedStore {
  if (config.infrastructure.commandStore === 'sqlite') {
    const path = sqliteFile()
    if (!existsSync(resolve(path))) return { notChecked: `no database at ${path}` }
  } else if (!process.env['DATABASE_URL']) {
    return { notChecked: 'DATABASE_URL is not set' }
  }
  let store: CommandStore
  try {
    store = openStoreReadOnly(config)
  } catch (error) {
    return { notChecked: `the store could not be opened: ${errorText(error)}` }
  }
  const products = createProductRepository(store)
  const variants = createVariantRepository(store)
  const categories = createCategoryRepository(store)
  const customers = createCustomerRepository(store)
  const orders = createOrderRepository(store)
  const holds = (find: (tx: ReadTx) => Promise<unknown>) =>
    store.read(find).then((row) => row !== null)
  return {
    lookup: {
      productSlugExists: (slug) => holds((tx) => products.findBySlug(tx, slug)),
      skuExists: (sku) => holds((tx) => variants.findBySku(tx, sku)),
      categorySlugExists: (slug) => holds((tx) => categories.findBySlug(tx, slug)),
      customerEmailExists: (email) => holds((tx) => customers.findByEmail(tx, email)),
      orderNumberExists: (number) => holds((tx) => orders.findByOrderNumber(tx, number)),
    },
    close: () => store.close(),
  }
}

/** `nymbal import --dry-run`: the plan file, and nothing written to the store, its media or the import's state. */
export async function runImportPlan(run: ImportPlanRun): Promise<void> {
  const opened = openExistingStore(run.config)
  const existing = 'lookup' in opened ? opened.lookup : null
  try {
    const plan = await planWooCommerceImport(
      {
        credentials: run.credentials,
        entities: run.entities,
        gdpr: run.gdpr,
        currency: run.config.store.currency,
        concurrency: run.concurrency,
      },
      { existing, onProgress: run.onProgress },
    )
    if ('notChecked' in opened) plan.existingStore = { notChecked: opened.notChecked }
    plan.resumeStateFound = existsSync(run.statePath)
    const paths = await writePlan(plan, run.projectRoot, run.config.store.name)

    const width = Math.max(...run.entities.map((e) => e.length))
    outro(
      [
        p.green('✓ Import plan written: nothing was imported'),
        ...run.entities.map(
          (e) => `  ${e.padEnd(width)}  ${plan.counts[e].import} / ${plan.counts[e].source}`,
        ),
        `  Collisions: ${plan.collisions.length}`,
        `  Estimate:   about ${plan.estimate.seconds} s`,
        ...(typeof plan.existingStore === 'object'
          ? [p.yellow(`  ⚠ Not checked against the store: ${plan.existingStore.notChecked}`)]
          : []),
        ``,
        `  Plan: ${paths.markdown}`,
        `        ${paths.json}`,
      ].join('\n'),
    )
  } finally {
    if ('close' in opened) await opened.close()
  }
}
