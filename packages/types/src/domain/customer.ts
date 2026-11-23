import type { Address } from './order.js'

export interface CustomerAddress extends Address {
  id: string
  isDefaultBilling: boolean
  isDefaultShipping: boolean
}

export interface Customer {
  id: string
  email: string
  firstName: string
  lastName: string
  phone: string
  addresses: CustomerAddress[]
  orderCount: number
  totalSpentMinor: number
  metadata: Record<string, unknown>
  /** What an access token grants. Written by seed and admin code only, never taken from `metadata`. */
  roles: Role[]
  requiresPasswordReset: boolean
  /** `pending` until a sign-up follows its mailed link; absent for an account never asked to confirm. */
  emailVerification?: 'pending' | 'verified'
  createdAt: string
  updatedAt: string
}

/** A device the customer is signed in on: one sign-in, carried by its renewals. */
export interface CustomerSession {
  id: string
  /** Made on the server from the sign-in's `User-Agent`, from fixed words: "Chrome on macOS", "Unknown device". */
  device: string
  signedInAt: string
  /** The latest renewal, or the sign-in when there has been none. */
  lastActiveAt: string
  /** The session of the access token that asked. */
  current: boolean
}

export interface CustomerProfile {
  customerId: string
  orderCount: number
  totalSpentMinor: number
  segment: string
  createdAt: string
}

export type Role = 'admin' | 'customer' | 'guest'
