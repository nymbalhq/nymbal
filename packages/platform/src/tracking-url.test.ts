import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { normaliseTrackingNumber } from '@nymbalhq/types'
import { trackingUrl } from './tracking-url.js'

// The carrier's tracking page for a number, as the shipped email links it: one pinned template per carrier, the
// merchant's text deciding only the escaped number in the one component the template names.

interface Carrier {
  /** As a merchant types it, the table's display spelling. */
  display: string
  /** Every alias, normalised: lower case, nothing outside [a-z0-9]. */
  aliases: string[]
  /** The template's URL with the number `AB12CD34`. */
  pinned: string
  host: string
  pathname: string
  /** The query key holding the number; null when it is in the fragment. */
  key: string | null
}

const CARRIERS: Carrier[] = [
  {
    display: 'USPS',
    aliases: ['usps', 'unitedstatespostalservice'],
    pinned: 'https://tools.usps.com/go/TrackConfirmAction?tLabels=AB12CD34',
    host: 'tools.usps.com',
    pathname: '/go/TrackConfirmAction',
    key: 'tLabels',
  },
  {
    display: 'UPS',
    aliases: ['ups', 'unitedparcelservice'],
    pinned: 'https://www.ups.com/track?tracknum=AB12CD34',
    host: 'www.ups.com',
    pathname: '/track',
    key: 'tracknum',
  },
  {
    display: 'FedEx',
    aliases: ['fedex', 'federalexpress'],
    pinned: 'https://www.fedex.com/fedextrack/?trknbr=AB12CD34',
    host: 'www.fedex.com',
    pathname: '/fedextrack/',
    key: 'trknbr',
  },
  {
    display: 'DHL',
    aliases: ['dhl', 'dhlexpress'],
    pinned: 'https://www.dhl.com/global-en/home/tracking.html?tracking-id=AB12CD34',
    host: 'www.dhl.com',
    pathname: '/global-en/home/tracking.html',
    key: 'tracking-id',
  },
  {
    display: 'Royal Mail',
    aliases: ['royalmail'],
    pinned: 'https://www.royalmail.com/track-your-item#/tracking-results/AB12CD34',
    host: 'www.royalmail.com',
    pathname: '/track-your-item',
    key: null,
  },
]

const ALIASES = new Set(CARRIERS.flatMap((c) => c.aliases))
const FRAGMENT_PREFIX = '#/tracking-results/'

/** An alias as a merchant might type it: any case, with spaces, dots or hyphens around and between its letters. */
const spelled = (alias: string): fc.Arbitrary<string> =>
  fc
    .tuple(
      fc.array(fc.boolean(), { minLength: alias.length, maxLength: alias.length }),
      fc.array(fc.constantFrom('', '', ' ', '.', '-', ' - '), {
        minLength: alias.length + 1,
        maxLength: alias.length + 1,
      }),
    )
    .map(
      ([upper, gaps]) =>
        gaps[0] +
        [...alias].map((ch, i) => (upper[i] ? ch.toUpperCase() : ch) + gaps[i + 1]).join(''),
    )

const carrierSpelling: fc.Arbitrary<{ carrier: Carrier; typed: string }> = fc
  .constantFrom(...CARRIERS)
  .chain((carrier) =>
    fc
      .constantFrom(...carrier.aliases)
      .chain(spelled)
      .map((typed) => ({ carrier, typed })),
  )

/** A number as typed, from letters, digits and spaces with the characters that could break out of a URL component. */
const typedNumber = fc
  .array(
    fc.oneof(
      fc.constantFrom(...'ABCXYZabcxyz0123456789'),
      fc.constant(' '),
      fc.constantFrom(...`&#/?%<>"'+=;`),
    ),
    { minLength: 1, maxLength: 24 },
  )
  .map((chars) => chars.join(''))
  .filter((n) => normaliseTrackingNumber(n) !== '')

/**
 * Where the number sits in `url` and what it decodes to: the query value for a query carrier (with the fragment, which
 * must be empty), the fragment after the tracker's prefix for Royal Mail. A rest holding an unencoded `/`, `?` or `#`
 * reads as no number.
 */
function numberIn(carrier: Carrier, url: URL): { fragment: string; number: string | null } {
  if (carrier.key !== null) return { fragment: url.hash, number: url.searchParams.get(carrier.key) }
  if (!url.hash.startsWith(FRAGMENT_PREFIX)) return { fragment: url.hash, number: null }
  const rest = url.hash.slice(FRAGMENT_PREFIX.length)
  return { fragment: FRAGMENT_PREFIX, number: /[/?#]/.test(rest) ? null : decodeURIComponent(rest) }
}

const normalisedCarrier = (c: string): string => c.toLowerCase().replace(/[^a-z0-9]/g, '')

describe('trackingUrl', () => {
  // Kills: a carrier's template drifting from the one pinned (another host, path or parameter); the number not
  // normalised before it is placed.
  it('AC-6: for "ab 12 cd34" and each carrier’s display spelling (USPS, UPS, FedEx, DHL, Royal Mail), trackingUrl gives the pinned template with AB12CD34', () => {
    expect(CARRIERS.map((c) => [c.display, trackingUrl(c.display, 'ab 12 cd34')])).toEqual(
      CARRIERS.map((c) => [c.display, c.pinned]),
    )
  })

  // Kills: a number with #, /, ? or & changing the URL's host, path, query keys or fragment prefix; whitespace or
  // lower case reaching the URL; an alias matched only in one spelling.
  it('AC-6: property: for every alias in any case with spaces, dots or hyphens, and any number with a non-empty normalised form, the URL is https on the template’s host and path with no credentials, the template’s query keys alone, and the number’s own component decodes to normaliseTrackingNumber(n)', () => {
    fc.assert(
      fc.property(carrierSpelling, typedNumber, ({ carrier, typed }, n) => {
        const href = trackingUrl(typed, n)
        const url = new URL(href ?? 'about:blank')
        expect([
          url.protocol,
          url.host,
          url.username,
          url.password,
          url.pathname,
          [...url.searchParams.keys()],
          numberIn(carrier, url),
        ]).toEqual([
          'https:',
          carrier.host,
          '',
          '',
          carrier.pathname,
          carrier.key === null ? [] : [carrier.key],
          {
            fragment: carrier.key === null ? FRAGMENT_PREFIX : '',
            number: normaliseTrackingNumber(n),
          },
        ])
      }),
      { numRuns: 400 },
    )
  })

  // Kills: an unknown carrier given a guessed link; a prefix match sending "UPS Mail Innovations" or "DHL eCommerce"
  // to a tracker that does not hold their numbers.
  it('AC-6: a carrier that normalises to no alias ("", "UPS Mail Innovations", "DHL eCommerce", "Bob\'s Van", and generated strings) gives null', () => {
    const named = ['', 'UPS Mail Innovations', 'DHL eCommerce', "Bob's Van", 'Parcelforce', 'DPD']
    expect(named.map((c) => [c, trackingUrl(c, '1Z999AA10123456784')])).toEqual(
      named.map((c) => [c, null]),
    )
    fc.assert(
      fc.property(
        fc.string({ maxLength: 30 }).filter((c) => !ALIASES.has(normalisedCarrier(c))),
        typedNumber,
        (carrier, n) => {
          expect(trackingUrl(carrier, n), JSON.stringify(carrier)).toBeNull()
        },
      ),
      { numRuns: 300 },
    )
  })

  // Kills: an empty or whitespace number giving a link to the tracker's search page.
  it('AC-6: a number empty after normalising ("", "   ", tabs and newlines) gives null for every carrier', () => {
    const empties = ['', '   ', '\t', ' \n \t ']
    const spellings = CARRIERS.flatMap((c) => [c.display, ...c.aliases])
    const links = spellings.flatMap((c) => empties.map((n) => trackingUrl(c, n)))
    expect(links).toEqual(spellings.flatMap(() => empties.map(() => null)))
  })
})
