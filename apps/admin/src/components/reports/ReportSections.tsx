import type { ReactNode } from 'react'
import type { ReportDefinitions, ReportSectionWindow, ReportSummary } from '@nymbalhq/types'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatMoney } from '@/lib/money'
import { tid } from '@/lib/testid'
import { formatRate, runwayDays, sourceLabel, windowLabel } from './format'

interface SectionProps {
  id: string
  title: string
  window: ReportSectionWindow
  children: ReactNode
}

/** A card labelled with its own window, never the chosen range. */
function Section({ id, title, window, children }: SectionProps) {
  return (
    <section className="min-w-0 space-y-3 rounded-lg border border-zinc-200 bg-white p-5">
      <div>
        <h2 className="text-sm font-semibold text-zinc-900">{title}</h2>
        <p data-testid={tid('reports', id, 'window')} className="text-xs text-zinc-500">
          {windowLabel(window)}
        </p>
      </div>
      {children}
    </section>
  )
}

const NONE = <p className="text-sm text-zinc-500">None in this range</p>

export function FunnelSection({ funnel }: { funnel: ReportSummary['funnel'] }) {
  const first = funnel.totals[0]
  if (first === undefined) return null
  const cells = [
    ['viewers', 'viewers'],
    ['carts', 'cartsWithItems'],
    ['checkouts', 'checkoutsStarted'],
    ['failed', 'paymentsFailed'],
    ['paid', 'paidOrders'],
  ] as const
  return (
    <Section id="funnel" title="Funnel" window={first.window}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Source</TableHead>
            <TableHead className="text-right">Viewers</TableHead>
            <TableHead className="text-right">Carts with items</TableHead>
            <TableHead className="text-right">Checkouts started</TableHead>
            <TableHead className="text-right">Payments failed</TableHead>
            <TableHead className="text-right">Paid orders</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {funnel.totals.map((f) => {
            const id = tid('reports', 'funnel', f.source)
            return (
              <TableRow key={f.source} data-testid={id}>
                <TableCell>{sourceLabel(f.source)}</TableCell>
                {cells.map(([cell, field]) => (
                  <TableCell key={cell} data-testid={`${id}-${cell}`} className="text-right">
                    {String(f[field])}
                  </TableCell>
                ))}
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </Section>
  )
}

const RATE_NAMES = {
  paidPerCheckoutStarted: 'Paid per checkout started',
  paidPerCartWithItems: 'Paid per cart with items',
  paidPerMeasuredViewer: 'Paid per measured viewer',
} as const

export function RatesSection({ rates }: { rates: ReportSummary['rates'] }) {
  const keys = Object.keys(RATE_NAMES) as Array<keyof typeof RATE_NAMES>
  return (
    <Section id="rates" title="Conversion" window={rates.paidPerCartWithItems.window}>
      <div className="grid gap-4 sm:grid-cols-3">
        {keys.map((key) => {
          const rate = rates[key]
          return (
            <div key={key} data-testid={tid('reports', 'rate', key)} className="space-y-1">
              <p className="text-xs text-zinc-500">{RATE_NAMES[key]}</p>
              {rate.rate === null ? (
                <>
                  <p className="text-base font-semibold text-zinc-900">—</p>
                  <p className="text-xs text-zinc-600">{rate.reason}</p>
                </>
              ) : (
                <p className="text-base font-semibold text-zinc-900">{formatRate(rate.rate)}</p>
              )}
              <p className="text-xs text-zinc-500">{rate.basis}</p>
            </div>
          )
        })}
      </div>
    </Section>
  )
}

export function TopProductsSection({ top }: { top: ReportSummary['topProducts'] }) {
  return (
    <Section id="top-products" title="Top products" window={top.window}>
      <div data-testid={tid('reports', 'top-products')}>
        {top.items.length === 0 ? (
          NONE
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead className="text-right">Units</TableHead>
                <TableHead className="text-right">Subtotal</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {top.items.map((item) => (
                <TableRow key={`${item.productId}-${item.currency}`}>
                  <TableCell>{item.productName}</TableCell>
                  <TableCell className="text-right">{String(item.units)}</TableCell>
                  <TableCell className="text-right">
                    {formatMoney(item.lineSubtotalMinor, item.currency)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </Section>
  )
}

export function SearchesSection({ searches }: { searches: ReportSummary['zeroResultSearches'] }) {
  return (
    <Section id="searches" title="Searches that found nothing" window={searches.window}>
      <div data-testid={tid('reports', 'searches')}>
        {searches.items.length === 0 ? (
          NONE
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Term</TableHead>
                <TableHead className="text-right">Searches</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {searches.items.map((s) => (
                <TableRow key={s.term} data-testid={tid('reports', 'search', s.term)}>
                  <TableCell className="break-all">{s.term}</TableCell>
                  <TableCell className="text-right">{String(s.searches)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </Section>
  )
}

export function RunwaySection({ runway }: { runway: ReportSummary['stockRunway'] }) {
  return (
    <Section id="runway" title="Stock runway" window={runway.window}>
      <div data-testid={tid('reports', 'runway')}>
        {runway.items.length === 0 ? (
          NONE
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Product</TableHead>
                <TableHead>SKU</TableHead>
                <TableHead className="text-right">Stock</TableHead>
                <TableHead className="text-right">Days left</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {runway.items.map((item) => (
                <TableRow key={item.variantId}>
                  <TableCell>{item.productName}</TableCell>
                  <TableCell>{item.sku}</TableCell>
                  <TableCell className="text-right">{String(item.stock)}</TableCell>
                  <TableCell
                    data-testid={tid('reports', 'runway', item.variantId, 'days')}
                    className="text-right"
                  >
                    {runwayDays(item)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </div>
    </Section>
  )
}

export function DefinitionsDisclosure({ definitions }: { definitions: ReportDefinitions }) {
  return (
    <details className="rounded-lg border border-zinc-200 bg-white p-5 text-sm">
      <summary className="cursor-pointer font-medium text-zinc-900">
        What these figures count
      </summary>
      <dl className="mt-3 space-y-2">
        {Object.entries(definitions).map(([name, text]) => (
          <div key={name}>
            <dt className="font-mono text-xs text-zinc-700">{name}</dt>
            <dd className="text-zinc-600">{text}</dd>
          </div>
        ))}
      </dl>
    </details>
  )
}
