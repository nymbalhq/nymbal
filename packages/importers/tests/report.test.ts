import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { formatReport } from '../src/report.js'
import { freshState, loadState } from '../src/state.js'
import type { ImportReport } from '../src/types.js'

// The migration report a merchant reads after an import: what could not be carried over exactly is listed under its
// own heading, after the errors, one line per warning.

type Warning = { phase: string; id?: string; message: string }

const text = fc
  .array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789 .,:'.split('')), {
    minLength: 3,
    maxLength: 40,
  })
  .map((chars) => `w ${chars.join('')}`)

const warning: fc.Arbitrary<Warning> = fc.record(
  {
    phase: fc.constantFrom('products', 'settings'),
    id: fc.integer({ min: 1, max: 9999 }).map(String),
    message: text,
  },
  { requiredKeys: ['phase', 'message'] },
)

function report(warnings: Warning[], errors: ImportReport['errors'] = []): ImportReport {
  return {
    imported: { categories: 1, products: 2, customers: 0, orders: 0, reviews: 0 },
    enriched: { enriched: 0, skipped: 0, failed: 0 },
    errors,
    warnings,
    updated: { products: 0 },
    changedNotUpdated: { orders: 0 },
    eventsEmitted: 3,
    durationMs: 1000,
  }
}

/** The lines under `heading`, up to the next heading. */
function section(markdown: string, heading: string): string[] {
  const lines = markdown.split('\n')
  const start = lines.indexOf(heading)
  if (start < 0) return []
  const end = lines.findIndex((l, i) => i > start && l.startsWith('## '))
  return lines.slice(start + 1, end < 0 ? lines.length : end).filter((l) => l.trim() !== '')
}

describe('formatReport warnings', () => {
  it('AC-9: property: "## Review before launch" holds one line per warning, each carrying its message, in order', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(warning, {
          minLength: 1,
          maxLength: 12,
          selector: (w) => `${w.phase}\u0000${w.id ?? ''}\u0000${w.message}`,
        }),
        (warnings) => {
          const lines = section(formatReport(report(warnings), 'Shop'), '## Review before launch')
          expect(lines.length).toBe(warnings.length)
          warnings.forEach((w, i) => {
            const carried = [w.message, ...(w.id === undefined ? [] : [w.id])]
            expect(
              carried.filter((part) => !lines[i]!.includes(part)),
              `line ${i}: ${lines[i]}`,
            ).toEqual([])
          })
        },
      ),
      { numRuns: 200 },
    )
  })

  it('AC-9: the review section comes after the errors', () => {
    const markdown = formatReport(
      report(
        [{ phase: 'products', id: '24', message: 'Grouped product imported as a draft' }],
        [{ phase: 'products', id: '30', error: 'variations could not be read' }],
      ),
      'Shop',
    )
    const lines = markdown.split('\n')
    const errors = lines.indexOf('## Errors Requiring Review')
    const review = lines.indexOf('## Review before launch')
    expect(errors).toBeGreaterThanOrEqual(0)
    expect(review).toBeGreaterThan(errors)
  })
})

describe('loadState warnings', () => {
  it('AC-9: a state file saved before warnings existed loads with no warnings', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'nymbal-state-warnings-'))
    try {
      const path = join(dir, '.nymbal-migration.json')
      const { warnings: _dropped, ...older } = freshState() as ReturnType<typeof freshState> & {
        warnings?: unknown
      }
      await writeFile(path, JSON.stringify(older), 'utf8')
      const loaded = await loadState(path)
      expect(loaded!.warnings).toEqual([])
      expect(loaded!.importedIds).toEqual(older.importedIds)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
