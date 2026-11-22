import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import type { ContentSource } from './claims.js'
import {
  FILLER_PHRASES,
  SEO_DESCRIPTION_MAX,
  SEO_DESCRIPTION_MIN,
  SEO_TITLE_MAX,
  checkSeoCopy,
} from './seo-rules.js'

// The copy rules a model's SEO title and description must meet before they can wait in the Inbox. No oracle: copy is
// generated to meet every rule, then broken in exactly one way, and the checker must name that rule on that field and
// nothing else. Lengths are Unicode code points after trim.

type Field = 'seoTitle' | 'seoDescription'
type Rule =
  | 'too_long'
  | 'too_short'
  | 'missing_name'
  | 'repeated_word'
  | 'all_caps'
  | 'emoji'
  | 'markup'
  | 'filler'

/** Neutral words of four or more letters: no claim, no filler, no word a generated name can be. */
const VOCAB = [
  'roomy',
  'sturdy',
  'simple',
  'daily',
  'pocket',
  'strap',
  'zipped',
  'handle',
  'shape',
  'light',
  'soft',
  'clean',
  'tidy',
  'travel',
  'weekend',
  'commute',
  'carry',
  'fold',
  'pack',
  'neat',
  'calm',
  'steady',
  'gentle',
  'bright',
  'quiet',
  'plain',
  'easy',
  'smooth',
  'broad',
  'compact',
  'spare',
  'sleek',
  'useful',
  'handy',
  'sized',
  'padded',
  'lined',
  'fresh',
  'modern',
  'rounded',
  'wide',
  'slim',
  'firm',
  'warm',
  'cosy',
  'airy',
  'deep',
  'flat',
  'open',
] as const

/** The phrases the rules name at least; each is in FILLER_PHRASES. */
const NAMED_FILLER = [
  'look no further',
  'elevate your',
  'unleash',
  'game-changer',
  'must-have',
  'best-in-class',
  'second to none',
] as const

const cp = (s: string) => [...s].length

function sourceOf(name: string, description = 'A plain bag for every day.'): ContentSource {
  return { name, description, shortDescription: '', variants: [], metadata: {} }
}

const pairsOf = (findings: ReadonlyArray<{ field: string; rule: string }>) => [
  ...new Set(findings.map((f) => `${f.field}:${f.rule}`)),
]

/** `prefix` grown with unused words from `pool`, then short filler, to exactly `n` code points. */
function exactly(prefix: string, n: number, pool: readonly string[]): string {
  let s = prefix
  for (const w of pool) {
    if (cp(s) + 1 + cp(w) <= n - 2) s += ` ${w}`
  }
  while (n - cp(s) >= 2) s += ' a'
  if (n - cp(s) === 1) s += '.'
  return s
}

interface Generated {
  name: string
  source: ContentSource
  title: string
  titleWords: string[]
  description: string
  descriptionWords: string[]
  unused: string[]
}

/** A name of one to three Q-words, a title holding it (any case) and a description, each meeting every rule. */
const valid: fc.Arbitrary<Generated> = fc
  .record({
    nameWords: fc.uniqueArray(fc.stringMatching(/^Q[a-z]{3,6}$/), { minLength: 1, maxLength: 3 }),
    order: fc.shuffledSubarray([...VOCAB], { minLength: VOCAB.length, maxLength: VOCAB.length }),
    titleExtra: fc.integer({ min: 1, max: 2 }),
    lowerName: fc.boolean(),
  })
  .map(({ nameWords, order, titleExtra, lowerName }) => {
    const name = nameWords.join(' ')
    const titleWords = order.slice(0, titleExtra)
    const rest = order.slice(titleExtra)
    const descriptionWords: string[] = []
    while (descriptionWords.join(' ').length < 85)
      descriptionWords.push(rest[descriptionWords.length]!)
    return {
      name,
      source: sourceOf(name),
      title: [lowerName ? name.toLowerCase() : name, ...titleWords].join(' '),
      titleWords,
      description: descriptionWords.join(' '),
      descriptionWords,
      unused: rest.slice(descriptionWords.length),
    }
  })

interface Broken {
  copy: { seoTitle: string; seoDescription: string }
  source: ContentSource
  field: Field
  rule: Rule
}

const pick = <T>(xs: readonly T[], i: number): T => xs[i % xs.length]!

/** The valid copy broken by exactly one rule on one field. */
function breakOne(g: Generated, rule: Rule, onTitle: boolean, i: number): Broken {
  const field: Field =
    rule === 'missing_name'
      ? 'seoTitle'
      : rule === 'too_short'
        ? 'seoDescription'
        : onTitle
          ? 'seoTitle'
          : 'seoDescription'
  const text = field === 'seoTitle' ? g.title : g.description
  const words = field === 'seoTitle' ? g.titleWords : g.descriptionWords
  let source = g.source
  let broken: string
  switch (rule) {
    case 'too_long': {
      const max = field === 'seoTitle' ? SEO_TITLE_MAX : SEO_DESCRIPTION_MAX
      broken = text
      for (const w of g.unused) {
        if (cp(broken) > max) break
        broken += ` ${w}`
      }
      break
    }
    case 'too_short':
      broken = g.descriptionWords.slice(0, 3).join(' ')
      break
    case 'missing_name':
      broken = g.unused.slice(0, 3).join(' ')
      break
    case 'repeated_word': {
      const w = pick(words, i)
      broken = `${text} ${w} ${w}`
      break
    }
    case 'all_caps': {
      const w = pick(words, i)
      broken = text.replace(new RegExp(`\\b${w}\\b`), w.toUpperCase())
      source = { ...source, description: `${source.description} It is ${w}.` }
      break
    }
    case 'emoji':
      broken = `${text} 🎒`
      break
    case 'markup':
      broken = pick([`${text} <`, `${text} >`, `${text.slice(0, text.lastIndexOf(' '))}\n${text.slice(text.lastIndexOf(' ') + 1)}`], i)
      break
    case 'filler':
      broken = `${text} ${pick(NAMED_FILLER, i)}`
      break
  }
  const copy = { seoTitle: g.title, seoDescription: g.description, [field]: broken }
  return { copy, source, field, rule }
}

const RULES: readonly Rule[] = [
  'too_long',
  'too_short',
  'missing_name',
  'repeated_word',
  'all_caps',
  'emoji',
  'markup',
  'filler',
]

describe('AC-2: checkSeoCopy, the copy rules', () => {
  it('AC-2: the bounds are a 60 code-point title and a 70 to 155 code-point description, and every phrase the rules name is filler', () => {
    expect([SEO_TITLE_MAX, SEO_DESCRIPTION_MIN, SEO_DESCRIPTION_MAX]).toEqual([60, 70, 155])
    expect(NAMED_FILLER.filter((phrase) => !FILLER_PHRASES.includes(phrase))).toEqual([])
  })

  it('AC-2: property: copy generated to meet every rule for a generated name gives no finding, whatever the case of the name in the title', () => {
    fc.assert(
      fc.property(valid, (g) => {
        expect(cp(g.title)).toBeLessThanOrEqual(SEO_TITLE_MAX)
        expect(
          checkSeoCopy(g.source, { seoTitle: g.title, seoDescription: g.description }),
        ).toEqual([])
      }),
      { numRuns: 200 },
    )
  })

  it('AC-2: property: the same copy with exactly one rule broken gives findings of that rule alone, on that field', () => {
    fc.assert(
      fc.property(
        valid,
        fc.constantFrom(...RULES),
        fc.boolean(),
        fc.nat(),
        (g, rule, onTitle, i) => {
          const b = breakOne(g, rule, onTitle, i)
          expect(pairsOf(checkSeoCopy(b.source, b.copy))).toEqual([`${b.field}:${b.rule}`])
        },
      ),
      { numRuns: 400 },
    )
  })

  it('AC-2: a 60 code-point title passes and a 61 code-point one is too long, though accents and a wide character make it longer in bytes and UTF-16 units', () => {
    const pool = [
      'légère',
      'éclat',
      'façade',
      'naïve',
      'côte',
      'mêlée',
      'étoile',
      'pâtisserie',
      'rôtie',
      'noël',
    ]
    const prefix = 'Café Crème 𠀋𠀋𠀋𠀋'
    const source = sourceOf('Café Crème')
    const description = exactly('Qalder', 100, VOCAB)
    const t60 = exactly(prefix, 60, pool)
    const t61 = exactly(prefix, 61, pool)

    expect([cp(t60), cp(t61)]).toEqual([60, 61])
    expect(t60.length).toBeGreaterThan(60)
    expect(Buffer.byteLength(t60)).toBeGreaterThan(60)
    expect(pairsOf(checkSeoCopy(source, { seoTitle: t60, seoDescription: description }))).toEqual(
      [],
    )
    expect(pairsOf(checkSeoCopy(source, { seoTitle: t61, seoDescription: description }))).toEqual([
      'seoTitle:too_long',
    ])
  })

  it('AC-2: a description of 69 code points is too short, 70 and 155 pass, and 156 is too long', () => {
    const source = sourceOf('Qalder')
    const title = 'Qalder roomy tote'
    const at = (n: number) => {
      const d = exactly('Qalder', n, VOCAB)
      expect(cp(d)).toBe(n)
      return pairsOf(checkSeoCopy(source, { seoTitle: title, seoDescription: d }))
    }

    expect([at(69), at(70), at(155), at(156)]).toEqual([
      ['seoDescription:too_short'],
      [],
      [],
      ['seoDescription:too_long'],
    ])
  })

  it('AC-2: for a name longer than 60, a title holding its first three words in order passes and one without them misses the name', () => {
    const name = 'Alpine Expedition Duffel Bag in Waxed Canvas with Leather Trim and Brass Hardware'
    const source = sourceOf(name)
    const description = exactly('A duffel', 110, VOCAB)

    expect(cp(name)).toBeGreaterThan(60)
    expect([
      pairsOf(
        checkSeoCopy(source, {
          seoTitle: 'Alpine Expedition Duffel, roomy and light',
          seoDescription: description,
        }),
      ),
      pairsOf(
        checkSeoCopy(source, {
          seoTitle: 'alpine expedition duffel for the weekend',
          seoDescription: description,
        }),
      ),
      pairsOf(
        checkSeoCopy(source, {
          seoTitle: 'Expedition Duffel Bag, roomy and light',
          seoDescription: description,
        }),
      ),
      pairsOf(
        checkSeoCopy(source, {
          seoTitle: 'Duffel Expedition Alpine, roomy and light',
          seoDescription: description,
        }),
      ),
    ]).toEqual([[], [], ['seoTitle:missing_name'], ['seoTitle:missing_name']])
  })

  it('AC-2: an all-caps word the product holds in caps passes, one it holds only in lower case does not, and one emoji is refused', () => {
    const source = sourceOf('Qalder Wallet', 'A slim wallet with an RFID sleeve and a coin pocket.')
    const description = exactly('A wallet', 100, VOCAB)
    const check = (seoTitle: string) =>
      pairsOf(checkSeoCopy(source, { seoTitle, seoDescription: description }))

    expect([
      check('Qalder Wallet with RFID sleeve'),
      check('Qalder Wallet with SLEEVE pocket'),
      check('Qalder Wallet with sleeve 👛'),
    ]).toEqual([[], ['seoTitle:all_caps'], ['seoTitle:emoji']])
  })
})
