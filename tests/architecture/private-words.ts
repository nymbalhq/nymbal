// The private process's words, which public text never carries: a task id, a phase number and the harness's own
// terms. The terms are assembled from parts so that this file holds none of them.

const TERMS = [
  ['gate', ':full'],
  ['Fa', 'ble'],
  ['store', ' walk'],
  ['cred', 'its'],
  ['spec', '-tester'],
].map((parts) => parts.join(''))

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const PATTERNS: readonly RegExp[] = [
  /\bP\d+-\d+\b/g,
  /\bphase\s+\d+/gi,
  ...TERMS.map((t) => new RegExp(`(?<![\\w-])${escape(t)}(?![\\w-])`, 'gi')),
]

/** Each private word the text holds, as written there. */
export function privateWords(text: string): string[] {
  return PATTERNS.flatMap((re) => [...text.matchAll(re)].map((m) => m[0]))
}
