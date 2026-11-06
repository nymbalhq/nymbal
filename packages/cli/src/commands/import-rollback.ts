import { confirm, isCancel, outro } from '@clack/prompts'
import p from 'picocolors'
import type { NymbalConfig } from '@nymbalhq/config'
import { createApp, newCorrelationId, runAsActor, runWithCorrelation } from '@nymbalhq/platform'
import {
  ImportStateError,
  loadState,
  rollbackImport,
  RollbackRefusedError,
  type ImportEntity,
  type ProgressCallback,
  type RollbackPlan,
} from '@nymbalhq/importers'
import { getCliVersion } from '../utils/version.js'

export interface ImportRollbackRun {
  config: NymbalConfig
  statePath: string
  /** Remove without asking. */
  yes: boolean
  isTTY: boolean
  onProgress: ProgressCallback
}

const ENTITIES: readonly ImportEntity[] = [
  'categories',
  'products',
  'customers',
  'orders',
  'reviews',
]
const label = (e: ImportEntity) => e[0]!.toUpperCase() + e.slice(1)

function kept(plan: RollbackPlan): string[] {
  return [
    `  Linked customers kept: ${plan.linkedCustomersKept}`,
    `  Media kept: ${plan.mediaUrls} image URLs (not deleted from storage)`,
  ]
}

async function confirmed(plan: RollbackPlan, run: ImportRollbackRun): Promise<boolean> {
  if (run.yes) return true
  console.log(
    [
      'The rollback will remove:',
      ...ENTITIES.map((e) => `  ${label(e)}: ${plan.remove[e]}`),
      ...kept(plan),
    ].join('\n'),
  )
  if (!run.isTTY) {
    console.error('Without a terminal to ask, run it again with --yes to remove these records.')
    return false
  }
  const answer = await confirm({ message: 'Remove these records from the store?' })
  return !isCancel(answer) && answer
}

/** Removes every record the imports in this project created, from the state file and its journal alone. */
export async function runImportRollback(run: ImportRollbackRun): Promise<void> {
  // An unreadable or missing state stops the rollback before the store is opened.
  try {
    if ((await loadState(run.statePath)) === null) {
      console.error(
        `Rollback refused (no-state): there is no import state at ${run.statePath} to roll back`,
      )
      process.exit(1)
    }
  } catch (err) {
    if (!(err instanceof ImportStateError)) throw err
    console.error(err.message)
    process.exit(1)
  }

  const app = await createApp(run.config, { version: getCliVersion() })
  let refused = false
  try {
    // One operation under one id, attributed to the import, so each removal's audit entry and event say whose it was.
    const report = await runWithCorrelation(newCorrelationId('import-rollback:woocommerce'), () =>
      runAsActor({ kind: 'import', id: 'woocommerce' }, () =>
        rollbackImport(
          { statePath: run.statePath, confirm: (plan) => confirmed(plan, run) },
          { services: app.services, repos: app.repos, onProgress: run.onProgress },
        ),
      ),
    )
    outro(
      [
        p.green('✓ Rollback complete'),
        ...ENTITIES.map(
          (e) =>
            `  ${label(e)}: ${report.removed[e]} removed` +
            (report.absent[e] > 0 ? ` (${report.absent[e]} already gone)` : ''),
        ),
        ...kept(report),
      ].join('\n'),
    )
  } catch (err) {
    if (!(err instanceof RollbackRefusedError || err instanceof ImportStateError)) throw err
    console.error(err.message)
    refused = true
  } finally {
    await app.stop()
  }
  if (refused) process.exit(1)
}
