// Reads: apps/docs/src/content/docs/assistant-data.md, packages/config/src/schema.ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ASSISTANT_MASK_FIELDS, DEFAULT_ASSISTANT_MASK } from '../../packages/config/src/schema'
import { ROOT } from './adapter-table'

// AC-13: the assistant-data page tells a store how its assistant masks a customer's details: the setting, its fields
// and default, the placeholder form, what free text is and is not caught, the cost, and the doctor line. The fields
// and the default are read from the config, so the page follows them if they change. Its links, anchors and private
// words stay public-docs.test.ts's; its table stays assistant-data-docs.test.ts's.

const PAGE = 'apps/docs/src/content/docs/assistant-data.md'

/** The text under the page's `## Masking` heading, up to the next `## `; '' when there is none. */
function maskingSection(text: string): string {
  const lines = text.split('\n')
  const start = lines.findIndex((line) => /^##\s+Masking\s*$/.test(line))
  if (start === -1) return ''
  const end = lines.findIndex((line, i) => i > start && /^##\s/.test(line))
  return lines.slice(start + 1, end === -1 ? undefined : end).join('\n')
}

const paragraphs = (text: string): string[] => text.split(/\n\s*\n/)

/** Each field the text names as code (`email` or `'email'`), in the config's order. */
const namedFields = (text: string): string[] =>
  ASSISTANT_MASK_FIELDS.filter((field: string) => new RegExp(`\`'?${field}'?\``).test(text))

describe('AC-13: the docs say what the assistant masks and what it costs', () => {
  it('AC-13: assistant-data.md has a Masking section naming agents.assistant.mask and every one of its fields as code, and a paragraph giving the default that names each default field', () => {
    const section = maskingSection(readFileSync(join(ROOT, PAGE), 'utf8'))

    expect(section.trim().length, `${PAGE} has no "## Masking" section`).toBeGreaterThan(0)
    expect(section).toContain('agents.assistant.mask')
    expect(namedFields(section)).toEqual([...ASSISTANT_MASK_FIELDS])
    const defaults = paragraphs(section).filter((p) => /\bdefault\b/i.test(p))
    expect(
      defaults.some(
        (p) => DEFAULT_ASSISTANT_MASK.every((field: string) => p.includes(field)),
      ),
      'no paragraph of the section gives the default fields',
    ).toBe(true)
  })

  it('AC-13: the section gives the [email-1] form and the [email 1] rewrite, says postcodes, street lines and names typed in free text are masked only once a field has shown them, names the 555-123-4567 miss and the 012345 678905 false positive, the follow-up, the accuracy cost and mask: []; the page names the ai host line of nymbal doctor', () => {
    const text = readFileSync(join(ROOT, PAGE), 'utf8')
    const section = maskingSection(text)
    const freeText = paragraphs(section).filter((p) => /free text/i.test(p))

    expect(section.trim().length, `${PAGE} has no "## Masking" section`).toBeGreaterThan(0)
    expect(
      ['[email-1]', '[email 1]', '555-123-4567', '012345 678905', 'mask: []'].filter(
        (s) => !section.includes(s),
      ),
    ).toEqual([])
    expect(
      freeText.some((p) => /postcode/i.test(p) && /street/i.test(p) && /\bnames?\b/i.test(p)),
      'no free-text paragraph names postcodes, street lines and names',
    ).toBe(true)
    expect(/follow-up|follow up/i.test(section)).toBe(true)
    expect(/accura/i.test(section)).toBe(true)
    expect(text).toContain('ai host')
    expect(text).toContain('nymbal doctor')
  })
})
