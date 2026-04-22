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
  requiresPasswordReset: boolean
  createdAt: string
  updatedAt: string
}

export interface CustomerProfile {
  customerId: string
  orderCount: number
  totalSpentMinor: number
  segment: string
  createdAt: string
}

export type Role = 'admin' | 'customer' | 'guest'
