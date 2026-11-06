import type { Address } from '@nymbalhq/types'

/** An ACP `Address`, as the pinned schema requires it. */
export interface AcpAddress {
  name: string
  line_one: string
  line_two?: string | undefined
  city: string
  state: string
  country: string
  postal_code: string
  company?: string | undefined
}

/** An ACP address as an order's: the name split at its first space, `state` as the region. */
export function toNymbalAddress(acp: AcpAddress, phone?: string): Address {
  const name = acp.name.trim()
  const space = name.indexOf(' ')
  return {
    firstName: space < 0 ? name : name.slice(0, space),
    lastName: space < 0 ? '' : name.slice(space + 1).trim(),
    ...(acp.company !== undefined && { company: acp.company }),
    addressLine1: acp.line_one,
    ...(acp.line_two !== undefined && { addressLine2: acp.line_two }),
    city: acp.city,
    region: acp.state,
    postalCode: acp.postal_code,
    country: acp.country,
    ...(phone !== undefined && { phone }),
  }
}
