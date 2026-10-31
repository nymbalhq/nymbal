import { slotFolder } from '@nymbalhq/config'
import { displayUrl } from '@nymbalhq/types'

/** What `nymbal dev` reports once it is up. */
export type DevSummaryInfo = {
  store: string
  apiUrl: string
  /** null under `--api-only`. */
  storefront: { template: string; url: string } | null
  /** null when the admin is not built. */
  admin: { url: string } | null
  commandStore: { kind: 'sqlite'; path: string } | { kind: 'postgres'; url: string }
  slots: Array<{ slot: string; provider: string; capabilities: readonly string[] }>
  primitives: Array<{ name: 'documentStore' | 'eventBus' | 'media'; provider: string }>
}

/** A terminal this narrow still shows every line whole. */
const WIDTH = 100
const LABEL = 14
/** Slot and provider names longer than this push the capability column no further. */
const NAME_COLUMN = 20

/** Columns as a terminal counts them: one per code point. */
const columns = (text: string) => [...text].length

function fit(text: string, width = WIDTH): string {
  return columns(text) <= width ? text : `${[...text].slice(0, width - 1).join('')}…`
}

function row(label: string, value: string): string {
  return fit(`  ${label.padEnd(LABEL)} ${value}`)
}

/** The capabilities that fit in `width`, whole and in order; the rest are counted, as `… (+n)`. */
function capabilityList(capabilities: readonly string[], width: number): string {
  if (capabilities.length === 0) return '—'
  const all = capabilities.join(', ')
  if (columns(all) <= width) return all
  for (let shown = capabilities.length - 1; shown > 0; shown--) {
    const text = `${capabilities.slice(0, shown).join(', ')}, … (+${capabilities.length - shown})`
    if (columns(text) <= width) return text
  }
  return `… (+${capabilities.length})`
}

/**
 * The screen `nymbal dev` prints once the store is up: the store, its URLs, the command store, each commerce slot's
 * provider and capabilities, and each primitive's provider. At most 30 lines of at most 100 columns, and never a
 * credential: a Postgres URL is shown as `scheme://host:port/db`.
 */
export function renderDevSummary(info: DevSummaryInfo): string {
  const slotWidth = Math.min(NAME_COLUMN, Math.max(...info.slots.map((s) => columns(s.slot)), 0))
  const providerWidth = Math.min(
    NAME_COLUMN,
    Math.max(...info.slots.map((s) => columns(s.provider)), 0),
  )
  const slotLines = info.slots.map(({ slot, provider, capabilities }) => {
    const lead = `  ${slot.padEnd(slotWidth)}  ${provider.padEnd(providerWidth)}  `
    return fit(`${lead}${capabilityList(capabilities, WIDTH - columns(lead))}`)
  })
  const commandStore =
    info.commandStore.kind === 'sqlite'
      ? `sqlite  ${info.commandStore.path}`
      : `postgres  ${displayUrl(info.commandStore.url)}`
  const lines = [
    fit(`  ${info.store}`),
    '',
    row('API', info.apiUrl),
    row(
      'storefront',
      info.storefront === null
        ? 'not started (--api-only)'
        : `${info.storefront.url}  (${info.storefront.template})`,
    ),
    row(
      'admin',
      info.admin === null ? 'not built — run pnpm --filter @nymbalhq/admin build' : info.admin.url,
    ),
    row('command store', commandStore),
    '',
    ...slotLines,
    '',
    ...info.primitives.map(({ name, provider }) => row(slotFolder(name), provider)),
    '',
    '  Debug logs: run with --verbose (or LOG_LEVEL=debug).',
  ]
  return `${lines.join('\n')}\n`
}
