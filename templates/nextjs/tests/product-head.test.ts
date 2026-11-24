import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { descriptionText, productHead } from '@/lib/seo'

// The product page's metadata (nextjs): a product's own SEO title and description when it has them, today's strings
// when either is blank. A set SEO title is absolute, so the layout's "%s | Nymbal" template does not wrap it.

const nonBlank = fc
  .string({ minLength: 1, maxLength: 70 })
  .filter((s) => s.trim() !== '' && s === s.trim())
const blank = fc.constantFrom('', ' ', '   ', '\t', '\n ')
const plain = fc.string({ maxLength: 120 })
const name = fc.stringMatching(/^[A-Z][a-z]{1,12}( [A-Z][a-z]{1,12}){0,2}$/)

const product = fc.record({
  name,
  shortDescription: plain,
  description: plain,
  seoTitle: fc.oneof(nonBlank, blank),
  seoDescription: fc.oneof(nonBlank, blank),
})

describe('AC-18: productHead (nextjs)', () => {
  it('AC-18: property: a non-blank seoTitle is the title with absolute true; a blank or whitespace-only one gives the name, not absolute, for the layout template to wrap', () => {
    fc.assert(
      fc.property(product, (p) => {
        const head = productHead(p)
        const set = p.seoTitle.trim() !== ''
        expect([head.title, head.absolute]).toEqual(set ? [p.seoTitle, true] : [p.name, false])
      }),
      { numRuns: 300 },
    )
  })

  it('AC-18: property: a non-blank seoDescription is the description; a blank one keeps descriptionText(shortDescription || description), else "Buy <name>."', () => {
    fc.assert(
      fc.property(product, (p) => {
        const set = p.seoDescription.trim() !== ''
        expect(productHead(p).description).toBe(
          set ? p.seoDescription : descriptionText(p.shortDescription || p.description) || `Buy ${p.name}.`,
        )
      }),
      { numRuns: 300 },
    )
  })

  it('AC-18: a 60-character SEO title is absolute, and a product with both fields blank and no description reads "Buy <name>."', () => {
    const seoTitle = 'Waxed Canvas Field Tote with Leather Handles and Brass Zip!!'
    const both = productHead({
      name: 'Field Tote',
      shortDescription: '',
      description: '<p>Soft &amp; warm</p>',
      seoTitle,
      seoDescription: '',
    })
    const neither = productHead({
      name: 'Field Tote',
      shortDescription: '',
      description: '',
      seoTitle: ' ',
      seoDescription: '',
    })

    expect(seoTitle.length).toBe(60)
    expect([both.title, both.absolute, neither.title, neither.absolute, neither.description]).toEqual([
      seoTitle,
      true,
      'Field Tote',
      false,
      'Buy Field Tote.',
    ])
  })
})
