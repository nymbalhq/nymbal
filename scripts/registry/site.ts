import { CONTRACT_KINDS } from '../../packages/contract-tests/src/kinds'
import type { EntryHistory, EntryStatus } from './status'

// Every string here comes from a manifest anyone may send a pull request to, or from the output of an adapter nobody
// here wrote: it is escaped where it is written, and a link is made only from an https: URL.

const REPO_URL = 'https://github.com/nymbalhq/nymbal'

/** A manifest entry as the page reads it: any field may hold anything, so each is written as escaped text. */
export type PageEntry = { package: string } & Record<string, unknown>

/** The badge's file, by the package slug rule `nymbal test:contracts --package` uses for its own files. */
export function badgePath(pkg: string): string {
  return `badges/${pkg.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '')}.svg`
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

/** Text or an attribute value, for HTML and for XML alike. */
function esc(value: unknown): string {
  return String(value).replace(/[&<>"']/g, (c) => ESCAPES[c]!)
}

const COLOURS: Record<EntryStatus, string> = {
  passing: '#2e7d32',
  failing: '#c62828',
  suspended: '#6a1b9a',
  'no-suite': '#757575',
  'first-party': '#1565c0',
}

const WORDS: Record<EntryStatus, string> = {
  passing: 'passing',
  failing: 'failing',
  suspended: 'suspended',
  'no-suite': 'no suite',
  'first-party': 'first-party',
}

/** A flat two-part badge: the label, then the status in its colour. */
export function renderBadge(label: string, status: EntryStatus): string {
  const message = WORDS[status]
  const width = (text: string) => 10 + text.length * 7
  const left = width(label)
  const right = width(message)
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${left + right}" height="20" role="img" aria-label="${esc(`${label}: ${message}`)}">`,
    `<title>${esc(`${label}: ${message}`)}</title>`,
    `<rect width="${left}" height="20" fill="#555"/>`,
    `<rect x="${left}" width="${right}" height="20" fill="${COLOURS[status]}"/>`,
    `<g font-family="Verdana,DejaVu Sans,sans-serif" font-size="11" fill="#fff">`,
    `<text x="5" y="14">${esc(label)}</text>`,
    `<text x="${left + 5}" y="14">${esc(message)}</text>`,
    `</g>`,
    `</svg>`,
    '',
  ].join('\n')
}

/** Slots whose kind has a contract suite: their first-party adapters are tested in CI. */
const SUITE_SLOTS = new Set<string>(
  CONTRACT_KINDS.map((k) => k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)),
)

function link(href: unknown, text: string): string {
  return typeof href === 'string' && href.startsWith('https://')
    ? `<a href="${esc(href)}">${esc(text)}</a>`
    : ''
}

function row(entry: PageEntry, h: EntryHistory | undefined): string {
  const status = h?.status
  const word =
    status === undefined
      ? 'not run'
      : status === 'first-party' && SUITE_SLOTS.has(String(entry['slot']))
        ? 'first-party, tested in CI'
        : WORDS[status]
  const links = [link(entry['maintainer'], 'maintainer'), link(entry['repository'], 'repository')]
    .filter(Boolean)
    .join(' ')
  return [
    '<tr>',
    `<td><code>${esc(entry.package)}</code></td>`,
    `<td>${esc(entry['slot'])}</td>`,
    `<td>${esc(entry['provider'])}</td>`,
    `<td>${esc(entry['tier'])}</td>`,
    `<td><img src="${esc(badgePath(entry.package))}" alt="${esc(word)}"> ${esc(word)}</td>`,
    `<td>${h === undefined ? '' : `<time datetime="${esc(h.lastRun)}">${esc(h.lastRun)}</time>`}</td>`,
    `<td>${h === undefined || h.line === '' ? '' : `<code>${esc(h.line)}</code>`}</td>`,
    `<td>${links}</td>`,
    '</tr>',
  ].join('')
}

export function renderStatusPage(
  manifest: { adapters: readonly PageEntry[] },
  history: Record<string, EntryHistory>,
  generatedAt: Date,
): string {
  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head><meta charset="utf-8"><title>Nymbal adapter registry</title></head>',
    '<body>',
    '<h1>Nymbal adapter registry</h1>',
    `<p>Every adapter listed in the registry and how it did on its last nightly run. ` +
      `<a href="${REPO_URL}/blob/main/registry/README.md">How the registry works</a></p>`,
    '<table>',
    '<thead><tr><th>Package</th><th>Slot</th><th>Provider</th><th>Tier</th><th>Status</th><th>Last run</th><th>Result</th><th>Links</th></tr></thead>',
    '<tbody>',
    ...manifest.adapters.map((e) => row(e, history[e.package])),
    '</tbody>',
    '</table>',
    `<p>Generated <time datetime="${generatedAt.toISOString()}">${generatedAt.toISOString()}</time>.</p>`,
    '</body>',
    '</html>',
    '',
  ].join('\n')
}
