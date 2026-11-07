import { useEffect, useRef, type KeyboardEvent } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { AlertCircle, Check, Sparkles, X } from 'lucide-react'
import { useAssistant, type AssistantExchange } from '@/hooks/useAssistant'
import { useCommandPalette } from '@/hooks/useCommandPalette'
import { tid } from '@/lib/testid'
import { AssistantProposalCard } from './AssistantProposalCard'
import { AssistantRecordCard } from './AssistantRecordCard'

function Exchange({ exchange }: { exchange: AssistantExchange }) {
  const close = useCommandPalette((s) => s.close)
  const { state, error } = exchange
  return (
    <div className="space-y-2">
      <p
        className="ml-auto w-fit max-w-[85%] rounded-lg bg-blue-600 px-3 py-2 text-sm whitespace-pre-wrap text-white"
        data-testid={tid('assistant', 'message')}
        data-role="user"
      >
        {exchange.question}
      </p>
      <div className="space-y-2" data-testid={tid('assistant', 'message')} data-role="assistant">
        {exchange.steps.map((step, i) => (
          <p
            key={i}
            className="flex items-center gap-1.5 text-xs text-zinc-500"
            data-testid={tid('assistant', 'step')}
            data-tool={step.name}
            data-ok={String(step.ok)}
          >
            {step.ok ? (
              <Check className="h-3 w-3 text-green-600" />
            ) : (
              <X className="h-3 w-3 text-red-500" />
            )}
            <span className="font-mono">{step.title}</span>
            {step.code !== undefined && <span className="text-red-500">{step.code}</span>}
          </p>
        ))}
        {exchange.records.map((record) => (
          <AssistantRecordCard
            key={record.kind === 'order' ? `order:${record.orderNumber}` : `customer:${record.id}`}
            record={record}
          />
        ))}
        {exchange.proposals.map((proposal) => (
          <AssistantProposalCard key={proposal.id} proposal={proposal} />
        ))}
        {exchange.unavailable === true ? (
          <p
            className="rounded-md bg-amber-50 p-3 text-sm text-amber-800"
            data-testid={tid('assistant', 'unavailable')}
          >
            The assistant needs an AI provider that can call tools.{' '}
            <Link to="/settings" className="font-medium underline" onClick={close}>
              Set one up in Settings
            </Link>
            .
          </p>
        ) : (
          <p
            className="text-sm whitespace-pre-wrap text-zinc-800"
            data-testid={tid('assistant', 'answer')}
            data-state={state}
          >
            {exchange.answer}
            {state === 'stopped' && (
              <span className="ml-1 text-xs text-zinc-400 italic">(Stopped)</span>
            )}
          </p>
        )}
        {state === 'streaming' && exchange.answer === '' && (
          <p className="text-xs text-zinc-400">Thinking…</p>
        )}
        {error !== undefined && exchange.unavailable !== true && (
          <p
            className="flex items-center gap-1.5 text-xs text-red-600"
            data-testid={tid('assistant', 'error')}
            data-code={error.code}
          >
            <AlertCircle className="h-3.5 w-3.5" />
            {error.message}
          </p>
        )}
      </div>
    </div>
  )
}

/** Ask: questions about the store, answered from its tools; a write the assistant wants is a card to approve. */
export function AssistantPanel({
  draft,
  onDraftChange,
}: {
  draft: string
  onDraftChange: (draft: string) => void
}) {
  const { exchanges, busy, ask } = useAssistant()
  const { pathname } = useLocation()
  const input = useRef<HTMLInputElement>(null)
  const end = useRef<HTMLDivElement>(null)
  const last = exchanges.at(-1)

  useEffect(() => {
    end.current?.scrollIntoView({ block: 'end' })
  }, [
    exchanges.length,
    last?.answer,
    last?.steps.length,
    last?.proposals.length,
    last?.records.length,
  ])

  useEffect(() => {
    if (!busy) input.current?.focus()
  }, [busy])

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return
    event.preventDefault()
    if (busy || draft.trim() === '') return
    ask(draft, pathname)
    onDraftChange('')
  }

  return (
    <div className="flex flex-col">
      <div className="max-h-[400px] min-h-24 space-y-4 overflow-y-auto px-4 py-3">
        {exchanges.length === 0 && (
          <p className="flex items-center gap-2 py-6 text-sm text-zinc-500">
            <Sparkles className="h-4 w-4" />
            Ask about your store: orders, products, stock. A change it suggests waits for your
            approval.
          </p>
        )}
        {exchanges.map((exchange) => (
          <Exchange key={exchange.id} exchange={exchange} />
        ))}
        <div ref={end} />
      </div>
      <div className="flex items-center border-t border-zinc-200 px-3">
        <Sparkles className="mr-2 h-4 w-4 shrink-0 opacity-50" />
        <input
          ref={input}
          className="flex h-12 w-full bg-transparent py-3 text-sm outline-none placeholder:text-zinc-400 disabled:cursor-not-allowed disabled:opacity-50"
          placeholder={busy ? 'Answering…' : 'Ask about your store, then press Enter'}
          value={draft}
          maxLength={8_000}
          disabled={busy}
          onChange={(event) => onDraftChange(event.target.value)}
          onKeyDown={onKeyDown}
          data-testid={tid('assistant', 'input')}
        />
      </div>
    </div>
  )
}
