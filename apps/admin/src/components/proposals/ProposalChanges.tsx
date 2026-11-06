import { PREVIEWED_COMMANDS, type ProposalChange, type ProposalView } from '@nymbalhq/types'
import { useProposal } from '@/hooks/useProposals'
import { formatMoney } from '@/lib/money'
import { tid } from '@/lib/testid'

/** A text value is cut here on the card; the arguments below still hold it whole. */
const TEXT_LIMIT = 120

function shown(value: string | number | null, kind: ProposalChange['kind'], currency: string) {
  if (value === null) return 'none'
  if (kind === 'money' && typeof value === 'number') return formatMoney(value, currency)
  const text = String(value)
  return text.length > TEXT_LIMIT ? `${text.slice(0, TEXT_LIMIT)}…` : text
}

function changeText(change: ProposalChange, currency: string): string {
  const { label, kind, current, proposed } = change
  if (kind === 'collection') {
    return `${label}: ${current ?? 0} → ${proposed ?? 0} items${change.changed === true ? ', changed' : ''}`
  }
  return `${label}: ${shown(current, kind, currency)} → ${shown(proposed, kind, currency)}`
}

/** The record a write's arguments name: a stock adjustment names a variant, the rest a product or an order. */
const namedId = (proposal: ProposalView) =>
  String(proposal.args[proposal.command === 'inventory.adjust' ? 'variantId' : 'id'] ?? '')

/**
 * What a pending write acts on and each value it changes, now beside proposed, read from the proposal's own route when
 * the card is shown. A proposal of a command with no preview reads nothing and shows nothing.
 */
export function ProposalChanges({
  proposal,
  scope,
}: {
  proposal: ProposalView
  scope: 'inbox' | 'assistant'
}) {
  const previewed = proposal.status === 'pending' && PREVIEWED_COMMANDS.includes(proposal.command)
  const { data } = useProposal(proposal.id, previewed)
  const preview = previewed ? data?.preview : undefined
  if (preview === undefined) return null
  const { target, changes, currency } = preview
  return (
    <div className="space-y-1 text-xs">
      <p
        className="font-medium break-words text-zinc-900"
        data-testid={tid(scope, 'target', proposal.id)}
      >
        {target === null ? `Not found: ${namedId(proposal)}` : target.label}
      </p>
      {changes.length > 0 && (
        <ul className="space-y-0.5 break-words text-zinc-700">
          {changes.map((change, i) => (
            <li key={i} data-testid={tid(scope, 'change', proposal.id)}>
              {changeText(change, currency)}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
