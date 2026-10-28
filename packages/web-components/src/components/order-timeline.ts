import { css, html, nothing } from 'lit'
import type { OrderTimelineKind } from '@nymbalhq/types'
import {
  baseStyles,
  NymbalElement,
  parsedJson,
  propertiesOf,
  type ElementSchema,
} from '../base-element.js'

const SCHEMA: ElementSchema = {
  tag: 'nymbal-order-timeline',
  reactName: 'OrderTimeline',
  // The `timeline` `GET /api/orders/:n` serves: `[{ kind, at }]`, oldest first.
  attributes: [
    { name: 'entries', prop: 'entries', type: 'json' },
    { name: 'time-zone', prop: 'timeZone', type: 'string' },
  ],
  events: [],
  parts: ['timeline', 'heading', 'list', 'entry', 'label', 'time'],
  slots: [],
  children: false,
}

const LABELS: Record<OrderTimelineKind, string> = {
  placed: 'Order placed',
  paid: 'Payment received',
  shipped: 'Shipped',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
  partially_refunded: 'Partially refunded',
  refunded: 'Refunded',
}

interface Entry {
  kind: OrderTimelineKind
  at: string
  date: Date
}

const formatters = new Map<string, Intl.DateTimeFormat>()

// The options are pinned so Node's ICU and the browser's give the same text; the zone is never the host's.
function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone)
  if (formatter === undefined) {
    try {
      formatter = new Intl.DateTimeFormat('en-GB', {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
        timeZone,
        timeZoneName: 'short',
      })
    } catch {
      formatter = formatterFor('UTC')
    }
    formatters.set(timeZone, formatter)
  }
  return formatter
}

function renderable(value: unknown): Entry[] {
  if (!Array.isArray(value)) return []
  const entries: Entry[] = []
  for (const item of value as unknown[]) {
    if (typeof item !== 'object' || item === null) continue
    const { kind, at } = item as { kind?: unknown; at?: unknown }
    if (typeof kind !== 'string' || !Object.hasOwn(LABELS, kind) || typeof at !== 'string') continue
    const date = new Date(at)
    if (Number.isNaN(date.getTime())) continue
    entries.push({ kind: kind as OrderTimelineKind, at, date })
  }
  return entries
}

/** What has happened to an order, oldest first, each entry with its time; the last is the order's current step. */
export class NymbalOrderTimeline extends NymbalElement {
  static override schema = SCHEMA
  static override properties = propertiesOf(SCHEMA)
  static override styles = [
    baseStyles,
    css`
      :host {
        display: block;
        font-family: var(--nymbal-font-family, system-ui, -apple-system, sans-serif);
        color: var(--nymbal-color-text, #18181b);
      }
      [part~='timeline'] {
        padding: var(--nymbal-spacing-lg, 1.5rem);
        background-color: var(--nymbal-color-surface, #ffffff);
        border: 1px solid var(--nymbal-color-border, #e4e4e7);
        border-radius: var(--nymbal-radius-lg, 0.75rem);
      }
      [part~='heading'] {
        margin: 0 0 var(--nymbal-spacing-md, 1rem);
        line-height: 1.2;
        font-size: var(--nymbal-font-size-lg, 1.125rem);
        font-weight: var(--nymbal-font-weight-bold, 700);
      }
      [part~='list'] {
        margin: 0;
        padding: 0;
        list-style: none;
      }
      [part~='entry'] {
        position: relative;
        display: flex;
        flex-wrap: wrap;
        justify-content: space-between;
        gap: var(--nymbal-spacing-xs, 0.25rem) var(--nymbal-spacing-md, 1rem);
        padding: var(--nymbal-spacing-xs, 0.25rem) 0 var(--nymbal-spacing-sm, 0.5rem)
          var(--nymbal-spacing-lg, 1.5rem);
        border-left: 2px solid var(--nymbal-color-border, #e4e4e7);
        font-size: var(--nymbal-font-size-sm, 0.875rem);
      }
      [part~='entry']::before {
        content: '';
        position: absolute;
        left: -0.4375rem;
        top: 0.375rem;
        width: 0.75rem;
        height: 0.75rem;
        border-radius: 50%;
        background-color: var(--nymbal-color-border, #e4e4e7);
      }
      [part~='entry'][aria-current='step']::before {
        background-color: var(--nymbal-color-primary, #18181b);
      }
      [part~='entry'][aria-current='step'] [part~='label'] {
        font-weight: var(--nymbal-font-weight-bold, 700);
      }
      [part~='time'] {
        color: var(--nymbal-color-text-muted, #71717a);
      }
    `,
  ]

  declare entries: unknown
  declare timeZone: string | undefined

  protected override render() {
    const entries = renderable(parsedJson<unknown>(this, 'entries', this.entries))
    if (entries.length === 0) return nothing
    const format = formatterFor(this.timeZone || 'UTC')
    const last = entries.length - 1
    return html`<section part="timeline" data-testid="order-timeline">
      <h2 part="heading">Order progress</h2>
      <ol part="list">
        ${entries.map(
          (e, i) =>
            html`<li
              part="entry"
              data-testid="timeline-entry"
              data-kind=${e.kind}
              aria-current=${i === last ? 'step' : nothing}
            >
              <span part="label">${LABELS[e.kind]}</span>
              <time part="time" datetime=${e.at}>${format.format(e.date)}</time>
            </li>`,
        )}
      </ol>
    </section>`
  }
}
