import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import {
  asRead,
  numbersIn,
  sourceDates,
  sourceNumbers,
  uncut,
  unsourcedNumbers,
} from './numbers.js'

// The no-new-numbers guard over AI guidance: what a text's figures read as, what a value the model read can source
// (never a part of an id, a date or a time, nor a cut line's counts), and the guard itself, which answers exactly the
// figures a text holds that no source does. The cut line is the one the assistant's loop appends to a non-list result
// it cut (`\n[cut: n of m characters not shown]`).

const cutLine = (notShown: number, of: number) =>
  `\n[cut: ${notShown} of ${of} characters not shown]`

describe('AC-1: numbersIn, sourceNumbers, sourceDates and uncut', () => {
  it('AC-1: numbersIn reads thousands commas, decimals, a percent, a unit, a date as three numbers, a trailing dot, a number ending a sentence and digits inside a word', () => {
    const read = [
      '1,234.50',
      '12.5%',
      '350ml',
      '2026-11-21',
      '12.',
      'Sold 7.',
      'size TEE001x',
      'from 12,345,678 views',
    ].map(numbersIn)

    expect(read).toEqual([[1234.5], [12.5], [350], [2026, 11, 21], [12], [7], [1], [12345678]])
  })

  it('AC-1: numbersIn reads an unparsable token (1.234,50 and 12,5) and one with a non-ASCII digit as NaN', () => {
    const read = ['1.234,50', 'about 12,5 of them', '١٢', '1٢'].map(numbersIn)

    expect(read).toEqual([[NaN], [NaN], [NaN], [NaN]])
  })

  it('AC-1: sourceNumbers of a uuid, an ISO time (with or without seconds, fraction and zone) and an ISO date gives nothing; of "on 2026-11-21 sold 7" gives 7 alone', () => {
    const sourced = [
      '0193a1b2-7c4d-7e8f-9a0b-1c2d3e4f5a6b',
      '2026-11-21T03:30:15.250Z',
      '2026-11-21T03:30',
      '2026-11-21T03:30:00+01:00',
      '2026-11-21',
      'on 2026-11-21 sold 7',
    ].map(sourceNumbers)

    expect(sourced).toEqual([[], [], [], [], [], [7]])
  })

  it('AC-1: sourceNumbers gives a number leaf as itself and a string leaf its numbers, keys none, NaN dropped, through arrays and objects', () => {
    const value = {
      units: 5,
      12: 'id 0193a1b2-7c4d-7e8f-9a0b-1c2d3e4f5a6b',
      series: [{ day: '2026-07-14', searches: 3 }, 1.5, 'sold 1,250 of 12,5'],
      missing: null,
      ok: true,
    }

    expect([...sourceNumbers(value)].sort((a, b) => a - b)).toEqual([1.5, 3, 5, 1250])
  })

  it('AC-1: sourceDates of an ISO time gives its date, and of a string holding two dates gives both', () => {
    expect(sourceDates('2026-11-21T03:30:00.000Z')).toEqual(['2026-11-21'])
    expect([...sourceDates({ note: 'from 2026-01-02 to 2026-01-09', n: 4 })].sort()).toEqual([
      '2026-01-02',
      '2026-01-09',
    ])
  })

  it('AC-1: uncut drops the cut line and the uuid prefix the cut left at the end, so neither the counts nor the prefix source a number; the figure before them still does', () => {
    const shown = '{"name":"Lamp","stock":8761,"id":"0193a1b2-7c'
    const text = `${shown}${cutLine(4321, 20321)}`

    const kept = uncut(text)

    expect(kept).toBe('{"name":"Lamp","stock":8761,"id":"')
    expect(sourceNumbers(kept)).toEqual([8761])
  })

  it('AC-1: asRead of a list result the loop cut drops its cut field, so the counts it names source no number and a guidance quoting them is unsourced; the items still source theirs', () => {
    const cutList = JSON.stringify({
      items: [{ name: 'Lamp', refunds: 1250 }],
      cut: '38 of 39 items not shown: ask for fewer',
    })

    const read = asRead(cutList)
    const sources = sourceNumbers(read)

    expect(read).toEqual({ items: [{ name: 'Lamp', refunds: 1250 }] })
    expect(sources).toEqual([1250])
    expect(unsourcedNumbers('38 refunds came from one customer.', sources, [], 0)).toEqual([38])
    expect(unsourcedNumbers('The lamp had 1,250 refunds.', sources, [], 0)).toEqual([])
  })

  it('AC-1: asRead keeps a cut key that is not the loop’s count, and a nested one, and parses any other JSON as it is', () => {
    const own = { items: [], cut: 'bevel 45' }
    const nested = { order: { cut: '3 of 4 items not shown: ask for fewer' } }

    expect([asRead(JSON.stringify(own)), asRead(JSON.stringify(nested)), asRead('[7]')]).toEqual([
      own,
      nested,
      [7],
    ])
    expect(asRead(`stock 8761, then${cutLine(10, 20)}`)).toBe('stock 8761, ')
  })

  it('AC-1: property: uncut returns a text without the cut line unchanged', () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 200 }).filter((s) => !s.includes('\n[cut:')),
        (text) => {
          expect(uncut(text)).toBe(text)
        },
      ),
    )
  })
})

// ---- the guard ------------------------------------------------------------------------------------------------

const day = fc
  .date({
    min: new Date('2000-01-01T00:00:00Z'),
    max: new Date('2099-12-31T23:59:59Z'),
    noInvalidDate: true,
  })
  .map((d) => d.toISOString())
const isoDate = day.map((iso) => iso.slice(0, 10))
const isoTime = fc
  .tuple(day, fc.constantFrom('full', 'minutes', 'offset'))
  .map(([iso, form]) =>
    form === 'full' ? iso : form === 'minutes' ? iso.slice(0, 16) : `${iso.slice(0, 19)}+01:00`,
  )
const whole = fc.integer({ min: 0, max: 50_000_000 })
const decimal = fc.integer({ min: 0, max: 5_000_000 }).map((n) => n / 100)
const word = fc.constantFrom('sold', 'term', 'units', 'Lamp', 'views', 'on', 'id')

/** A string a tool result might hold: words, a figure, and an id, a date or a time beside it. */
const sentence = fc
  .tuple(word, fc.oneof(whole, decimal), fc.oneof(fc.uuid(), isoDate, isoTime))
  .map(([w, n, tag]) => `${w} ${n} ${tag}`)

const leaf = fc.oneof(whole, decimal, sentence, fc.uuid(), isoDate, isoTime, word)

/** Sources shaped as the model reads them: facts, a day series as a report answers it, and records with ids and times. */
const sourcesArb = fc.record({
  facts: fc.dictionary(fc.constantFrom('units', 'searches', 'rate', 'term', 'label'), leaf, {
    maxKeys: 5,
  }),
  series: fc.array(fc.record({ day: isoDate, value: whole }), { minLength: 1, maxLength: 6 }),
  records: fc.array(fc.record({ id: fc.uuid(), at: isoTime, note: sentence }), {
    minLength: 1,
    maxLength: 4,
  }),
})

type Form = 'stored' | 'commas' | 'major' | 'majorCommas' | 'date'
const pickArb = fc.record({
  i: fc.nat(),
  form: fc.constantFrom<Form>('stored', 'commas', 'major', 'majorCommas', 'date'),
  sep: fc.constantFrom(' and ', ', ', '; ', ' then ', '. ', ' (', ') ', ' or about '),
  unit: fc.constantFrom('', '%', 'ml', ' units'),
})

function withCommas(text: string): string {
  const [int, frac] = text.split('.')
  const grouped = int!.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return frac === undefined ? grouped : `${grouped}.${frac}`
}

/** A stored whole number of minor units written as major units, as money is written (`1250` at 2 is `12.50`). */
const asMajor = (minor: number, minorUnits: number) =>
  (minor / 10 ** minorUnits).toFixed(minorUnits)

interface Assembled {
  pieces: string[]
  seps: string[]
}

/** The text a guidance could be, built from the sources' own figures and dates in the forms `picks` name. */
function assemble(
  picks: Array<{ i: number; form: Form; sep: string; unit: string }>,
  numbers: number[],
  dates: string[],
  minorUnits: number,
): Assembled {
  const wholes = numbers.filter((n) => Number.isInteger(n))
  const pieces: string[] = []
  const seps: string[] = []
  for (const pick of picks) {
    let piece: string | undefined
    if (pick.form === 'date' && dates.length > 0) piece = dates[pick.i % dates.length]
    else if (
      (pick.form === 'major' || pick.form === 'majorCommas') &&
      minorUnits > 0 &&
      wholes.length > 0
    ) {
      const major = asMajor(wholes[pick.i % wholes.length]!, minorUnits)
      piece = pick.form === 'major' ? major : withCommas(major)
    } else if ((pick.form === 'stored' || pick.form === 'commas') && numbers.length > 0) {
      const stored = String(numbers[pick.i % numbers.length])
      piece = pick.form === 'stored' ? stored : withCommas(stored)
    }
    if (piece === undefined) continue
    pieces.push(pick.form === 'date' ? piece : `${piece}${pick.unit}`)
    seps.push(pick.sep)
  }
  return { pieces, seps }
}

const textOf = ({ pieces, seps }: Assembled) =>
  `Look at ${pieces.map((p, n) => `${p}${seps[n]}`).join('')}the rest.`

/** Whether `x` is a figure the sources hold: as a value, or (minor units above 0) as major units of a stored whole. */
function sourced(x: number, numbers: number[], minorUnits: number): boolean {
  if (numbers.includes(x)) return true
  if (minorUnits === 0) return false
  const minor = x * 10 ** minorUnits
  return numbers.some((n) => Number.isInteger(n) && Math.abs(n - minor) < 1e-6)
}

/** The digit runs inside the sources' ids, dates and times: figures the guard must never take from them. */
function hiddenRuns(src: {
  series: Array<{ day: string }>
  records: Array<{ id: string; at: string }>
}): string[] {
  const tagged = [...src.series.map((s) => s.day), ...src.records.flatMap((r) => [r.id, r.at])]
  return tagged.flatMap((t) => t.match(/\d+/g) ?? [])
}

describe('AC-2: the guard answers exactly the figures no source holds', () => {
  it('AC-2: property: a text of the sources’ own figures (as stored, with thousands commas, or as major units at 2 and 3) and their dates quoted whole has no unsourced number; with one new figure inserted it answers exactly that figure, even one whose digits sit inside a source’s id, date or time', () => {
    fc.assert(
      fc.property(
        sourcesArb,
        fc.array(pickArb, { maxLength: 12 }),
        fc.constantFrom(0, 2, 3),
        fc.oneof(
          fc.record({ kind: fc.constant('hidden' as const), i: fc.nat() }),
          fc.record({ kind: fc.constant('free' as const), n: fc.oneof(whole, decimal) }),
        ),
        fc.nat(),
        (src, picks, minorUnits, insert, at) => {
          const numbers = sourceNumbers(src)
          const dates = sourceDates(src)
          const assembled = assemble(picks, numbers, dates, minorUnits)

          expect(unsourcedNumbers(textOf(assembled), numbers, dates, minorUnits)).toEqual([])

          const runs = hiddenRuns(src)
          const written =
            insert.kind === 'hidden' && runs.length > 0
              ? runs[insert.i % runs.length]!
              : String(insert.kind === 'free' ? insert.n : 0)
          const figure = Number(written)
          fc.pre(!sourced(figure, numbers, minorUnits))
          const n = assembled.pieces.length === 0 ? 0 : at % (assembled.pieces.length + 1)
          const withNew: Assembled = {
            pieces: [...assembled.pieces.slice(0, n), written, ...assembled.pieces.slice(n)],
            seps: [...assembled.seps.slice(0, n), ' and ', ...assembled.seps.slice(n)],
          }

          expect(unsourcedNumbers(textOf(withNew), numbers, dates, minorUnits)).toEqual([figure])
        },
      ),
      { numRuns: 300 },
    )
  })

  it('AC-2: property: at minor units 0 a stored whole written as major units is a new figure, and at 2 the same text is sourced', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 50_000_000 }).filter((n) => n % 100 !== 0),
        (minor) => {
          const text = `Revenue was about ${asMajor(minor, 2)} yesterday.`
          const numbers = sourceNumbers({ capturedMinor: minor })

          expect(unsourcedNumbers(text, numbers, [], 0)).toEqual([Number(asMajor(minor, 2))])
          expect(unsourcedNumbers(text, numbers, [], 2)).toEqual([])
        },
      ),
    )
  })

  it('AC-2: property: the month or day of a source’s date, written alone, is a new figure, while the date quoted whole is not', () => {
    fc.assert(
      fc.property(isoDate, fc.constantFrom(1, 2), (date, part) => {
        const src = { series: [{ day: date, value: 0 }] }
        const numbers = sourceNumbers(src)
        const dates = sourceDates(src)
        const alone = date.split('-')[part]!
        fc.pre(!numbers.includes(Number(alone)))

        expect(unsourcedNumbers(`Look at ${date}.`, numbers, dates, 2)).toEqual([])
        expect(unsourcedNumbers(`Look at day ${alone}.`, numbers, dates, 2)).toEqual([
          Number(alone),
        ])
      }),
    )
  })

  it('AC-2: NaN is always unsourced: a figure that does not parse is answered even when sources hold its parts', () => {
    const numbers = sourceNumbers({ a: 12, b: 5, c: 1.234, d: 50 })

    expect(unsourcedNumbers('About 12,5 or 1.234,50 of them.', numbers, [], 2)).toEqual([NaN, NaN])
  })
})
