import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ImportEntity, ImportPlan, PlanEntity } from './types.js'

const ENTITIES: ImportEntity[] = ['categories', 'products', 'customers', 'orders', 'reviews']
const PLAN_ENTITIES: PlanEntity[] = [...ENTITIES, 'variations']

const code = (s: string) => `\`${s.replace(/`/g, "'")}\``

export function formatPlan(plan: ImportPlan, storeName: string): string {
  const lines: string[] = [
    `# Nymbal Import Plan — ${storeName}`,
    `_Generated ${new Date().toISOString()} from ${plan.source.url}. Nothing was imported._`,
    '',
    typeof plan.existingStore === 'object'
      ? `Not checked against this store: ${plan.existingStore.notChecked}.`
      : 'Checked against what this store already holds.',
  ]
  if (plan.resumeStateFound) {
    lines.push(
      'An earlier import left resume state (`.nymbal-migration.json`); this plan counts as if `--fresh`.',
    )
  }

  lines.push(
    '',
    '## Counts',
    '',
    '| Entity | Source | Import | Refused | Skipped |',
    '|---|---|---|---|---|',
  )
  for (const e of ENTITIES) {
    const c = plan.counts[e]
    lines.push(`| ${e} | ${c.source} | ${c.import} | ${c.refused} | ${c.skipped} |`)
  }

  lines.push('', '## Collisions', '')
  if (plan.collisions.length === 0) lines.push('None.')
  for (const c of plan.collisions) {
    const value = c.value === '' ? '' : ` ${code(c.value)}`
    const outcome = c.outcome === 'refused' ? 'refused' : 'links to the existing customer'
    lines.push(
      `- ${c.kind}${value} (with the ${c.with}): WooCommerce ids ${c.sourceIds.join(', ')}; ${outcome}`,
    )
  }

  lines.push('', '## Unmapped fields', '')
  const unmapped = PLAN_ENTITIES.filter((e) => plan.unmapped[e].length > 0)
  if (unmapped.length === 0) lines.push('None.')
  for (const e of unmapped) {
    lines.push(`### ${e}`, '')
    for (const f of plan.unmapped[e]) lines.push(`- ${code(f.field)}: ${f.records} records`)
    lines.push('')
  }

  const { requests, meanRequestMs, writes, seconds } = plan.estimate
  lines.push(
    '',
    '## Estimate',
    '',
    `- About ${seconds} s`,
    `- ${requests.api} API requests and ${requests.images} image downloads, ${Math.round(meanRequestMs)} ms per request`,
    `- ${writes} records written`,
    '',
    "## Won't migrate",
    '',
  )
  for (const w of plan.wontMigrate) {
    lines.push(`- ${w.item}: ${w.count === null ? 'unknown' : w.count}. ${w.why}`)
  }
  lines.push('')
  return lines.join('\n')
}

/** `nymbal-import-plan.json` and `nymbal-import-plan.md` in `projectRoot`. */
export async function writePlan(
  plan: ImportPlan,
  projectRoot: string,
  storeName: string,
): Promise<{ json: string; markdown: string }> {
  const json = join(projectRoot, 'nymbal-import-plan.json')
  const markdown = join(projectRoot, 'nymbal-import-plan.md')
  await writeFile(json, JSON.stringify(plan, null, 2), 'utf-8')
  await writeFile(markdown, formatPlan(plan, storeName), 'utf-8')
  return { json, markdown }
}
