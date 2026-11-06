import { normaliseTrackingNumber } from '@nymbalhq/types'

type Template = (encodedNumber: string) => string

const usps: Template = (n) => `https://tools.usps.com/go/TrackConfirmAction?tLabels=${n}`
const ups: Template = (n) => `https://www.ups.com/track?tracknum=${n}`
const fedex: Template = (n) => `https://www.fedex.com/fedextrack/?trknbr=${n}`
const dhl: Template = (n) => `https://www.dhl.com/global-en/home/tracking.html?tracking-id=${n}`
const royalMail: Template = (n) =>
  `https://www.royalmail.com/track-your-item#/tracking-results/${n}`

// Exact aliases only: "UPS Mail Innovations" and "DHL eCommerce" are tracked elsewhere, so no prefix matching.
const BY_ALIAS: ReadonlyMap<string, Template> = new Map([
  ['usps', usps],
  ['unitedstatespostalservice', usps],
  ['ups', ups],
  ['unitedparcelservice', ups],
  ['fedex', fedex],
  ['federalexpress', fedex],
  ['dhl', dhl],
  ['dhlexpress', dhl],
  ['royalmail', royalMail],
])

/**
 * The carrier's public tracking page for a number, or null for a carrier the store has no tracker for or an empty
 * number. The carrier text picks the template; the number, normalised and percent-encoded, is the only input that
 * reaches the URL.
 */
export function trackingUrl(carrier: string, trackingNumber: string): string | null {
  const template = BY_ALIAS.get(carrier.toLowerCase().replace(/[^a-z0-9]/g, ''))
  const number = normaliseTrackingNumber(trackingNumber)
  if (template === undefined || number === '') return null
  return template(encodeURIComponent(number))
}
