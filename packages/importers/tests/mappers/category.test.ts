import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { WcCategory } from '../../src/woocommerce/client.js'
import { mapCategory, slugify } from '../../src/woocommerce/mappers/category.js'

const SLUG_SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+)*-?$/

/** Lowercase letters and digits, the characters a slug keeps. */
const word = fc.stringMatching(/^[a-z0-9]{1,12}$/)
/** A run of characters a slug turns into one hyphen: spaces, punctuation, hyphens, accents. */
const separator = fc
  .array(fc.constantFrom(' ', '-', '_', '/', '&', '.', "'", 'é', '’', '\t'), {
    minLength: 1,
    maxLength: 4,
  })
  .map((cs) => cs.join(''))
const anyCase = (s: string, upper: boolean[]) =>
  [...s].map((c, i) => (upper[i % upper.length] ? c.toUpperCase() : c)).join('')

function wcCategory(overrides: Partial<WcCategory> = {}): WcCategory {
  return { id: 7, name: 'Hats', slug: 'hats', parent: 0, description: '', count: 3, ...overrides }
}

describe('slugify', () => {
  it('property: words joined by any separator run become those words joined by one hyphen, lowercased', () => {
    // Catches: no lowercasing, one hyphen per separator character (`--`), separators left in,
    // leading or trailing hyphens kept.
    fc.assert(
      fc.property(
        fc.array(word, { minLength: 1, maxLength: 5 }),
        fc.array(separator, { minLength: 6, maxLength: 6 }),
        fc.array(fc.boolean(), { minLength: 1, maxLength: 8 }),
        (words, seps, upper) => {
          const input = seps[0] + words.map((w, i) => anyCase(w, upper) + seps[i + 1]).join('')
          const expected = words.join('-')
          expect(slugify(input)).toBe(expected)
        },
      ),
    )
  })

  it('property: any text slugs to lowercase letters and digits in single-hyphen runs, at most 80 long', () => {
    // Catches: the 80-character cap dropped, a character class that lets other characters through.
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (s) => {
        const slug = slugify(s)
        expect(slug.length).toBeLessThanOrEqual(80)
        expect(slug === '' || SLUG_SHAPE.test(slug)).toBe(true)
      }),
    )
  })

  it('property: a slug keeps every letter and digit of the input, in order, up to the cap', () => {
    // Catches: letters or digits stripped as separators, characters reordered or dropped.
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), (s) => {
        const kept = s.toLowerCase().replace(/[^a-z0-9]/g, '')
        expect(slugify(s).replace(/-/g, '')).toBe(kept)
      }),
    )
  })

  it('property: slugging a slug changes nothing', () => {
    // Catches: a slug that a second import would rename, which splits one category into two.
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), (s) => {
        const once = slugify(s)
        const twice = slugify(once)
        // A cut at 80 can end on a hyphen; the second pass trims it and changes nothing else.
        expect(twice).toBe(once.replace(/-$/, ''))
      }),
    )
  })

  it('a name longer than 80 characters is cut to its first 80 slug characters', () => {
    // Catches: the cap removed or moved (a 120-character slug the store rejects).
    const long = 'a'.repeat(120)
    expect(slugify(long)).toBe(long.slice(0, 80))
    expect(slugify(`${'b'.repeat(70)} ${'c'.repeat(20)}`)).toBe(
      `${'b'.repeat(70)}-${'c'.repeat(9)}`,
    )
  })

  it('text with no letters or digits slugs to nothing', () => {
    // Catches: the trim leaving a lone hyphen behind.
    expect(slugify(' & — ! ')).toBe('')
  })
})

describe('mapCategory', () => {
  it('property: a category keeps its name and parent link, and slugs its WooCommerce slug', () => {
    // Catches: the name altered, the parent link dropped or replaced, the slug taken from the name
    // while WooCommerce has one.
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 40 }),
        fc.array(word, { minLength: 1, maxLength: 3 }),
        fc.option(fc.uuid(), { nil: undefined }),
        (name, slugWords, parentId) => {
          const wc = wcCategory({ name, slug: slugWords.join('-') })
          const mapped = mapCategory(wc, parentId)
          expect(mapped.name).toBe(wc.name)
          expect(mapped.slug).toBe(wc.slug)
          expect(mapped.parentId).toBe(parentId ?? null)
        },
      ),
    )
  })

  it('a category with no WooCommerce slug takes its slug from its name', () => {
    // Catches: an empty slug when WooCommerce left the slug blank.
    const mapped = mapCategory(wcCategory({ name: 'Summer Hats & Caps', slug: '' }), undefined)
    expect(mapped.slug).toBe(slugify('Summer Hats & Caps'))
    expect(mapped.slug).toBe('summer-hats-caps')
  })

  it('a WooCommerce slug in mixed case or with spaces is normalised, not copied', () => {
    // Catches: the WooCommerce slug used raw, so `Hats ` and `hats` become two categories.
    const mapped = mapCategory(wcCategory({ name: 'Ignored', slug: ' Winter Hats ' }), undefined)
    expect(mapped.slug).toBe('winter-hats')
  })

  it('a top-level category has a null parent; a child carries the parent id it was given', () => {
    // Catches: `undefined` stored for a root, or the parent id lost for a child.
    const root = mapCategory(wcCategory(), undefined)
    const child = mapCategory(wcCategory({ id: 8, parent: 7 }), 'cat_parent')
    expect(root.parentId).toBeNull()
    expect(child.parentId).toBe('cat_parent')
    expect(child.position).toBe(root.position)
  })

  it('a description is carried over when WooCommerce has one and left off when it is empty', () => {
    // Catches: an empty description written over the field, or a real one dropped.
    const withText = mapCategory(wcCategory({ description: '<p>Warm hats</p>' }), undefined)
    const without = mapCategory(wcCategory({ description: '' }), undefined)
    expect(withText.description).toBe('<p>Warm hats</p>')
    expect('description' in without).toBe(false)
    expect(without.position).toBe(0)
  })
})
