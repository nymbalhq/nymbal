// All admin-specific types for Nymbal admin dashboard

export type OrderStatus =
  | 'pending'
  | 'confirmed'
  | 'processing'
  | 'shipped'
  | 'delivered'
  | 'cancelled'
  | 'refunded'
  | 'partially_refunded'

export const ORDER_STATUS_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  pending: ['confirmed', 'cancelled'],
  confirmed: ['processing', 'cancelled'],
  processing: ['shipped', 'cancelled'],
  shipped: ['delivered'],
  delivered: ['refunded', 'partially_refunded'],
  cancelled: [],
  refunded: [],
  partially_refunded: ['refunded'],
}

export interface Address {
  line1: string
  line2?: string
  city: string
  state: string
  postalCode: string
  country: string
}

export interface OrderLineItem {
  variantId: string
  productId: string
  productName: string
  variantName: string
  sku: string
  qty: number
  unitPriceMinor: number
  lineSubtotalMinor: number
  lineTaxMinor: number
  lineTotalMinor: number
  imageUrl: string
}

export interface Order {
  id: string
  orderNumber: string
  sequence: number
  customerId: string | null
  status: OrderStatus
  email: string
  billingAddress: Address
  shippingAddress: Address
  lineItems: OrderLineItem[]
  subtotalMinor: number
  taxTotalMinor: number
  shippingTotalMinor: number
  discountTotalMinor: number
  totalMinor: number
  currency: string
  notes: string
  metadata: Record<string, unknown>
  paymentIntentId: string | null
  createdAt: string
  updatedAt: string
}

export interface OrderHistoryEntry {
  id: string
  orderId: string
  fromStatus: OrderStatus | null
  toStatus: OrderStatus
  actor: string
  note: string
  timestamp: string
}

export interface OrderWithHistory extends Order {
  history: OrderHistoryEntry[]
}

export type ProductStatus = 'draft' | 'active' | 'archived'
export type ProductType = 'simple' | 'variable'

export interface ProductMedia {
  url: string
  altText: string
  position: number
}

export interface VariantOption {
  name: string
  value: string
}

export interface Variant {
  id: string
  productId: string
  sku: string
  name: string
  priceMinor: number
  compareAtPriceMinor: number | null
  stock: number
  lowStockThreshold: number
  options: VariantOption[]
  status: 'active' | 'inactive'
  createdAt: string
  updatedAt: string
}

export interface Product {
  id: string
  slug: string
  name: string
  description: string
  shortDescription: string
  status: ProductStatus
  type: ProductType
  seoTitle: string
  seoDescription: string
  media: ProductMedia[]
  metadata: Record<string, unknown>
  createdAt: string
  updatedAt: string
}

export interface ProductSnapshot extends Product {
  variants: Variant[]
  categoryIds: string[]
}

export interface CustomerAddress {
  id?: string
  line1: string
  line2?: string
  city: string
  state: string
  postalCode: string
  country: string
  isDefault?: boolean
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

export interface CustomerStats {
  orderCount: number
  lifetimeRevenueMinor: number
  avgOrderValueMinor: number
  firstOrderAt: string | null
  lastOrderAt: string | null
}

export type InventoryStatus = 'in_stock' | 'low_stock' | 'out_of_stock'

export interface InventoryRow {
  variantId: string
  productId: string
  productName: string
  sku: string
  options: VariantOption[]
  stock: number
  threshold: number
  status: InventoryStatus
  updatedAt: string
}

export interface NoteEntry {
  body: string
  actor: string
  at: string
}

export type StockAdjustmentReason =
  | 'sale'
  | 'return'
  | 'manual'
  | 'import'
  | 'reservation-commit'
  | 'reservation-release'

export interface StockAdjustment {
  id: string
  variantId: string
  adjustment: number
  reason: StockAdjustmentReason
  actor: string
  previousQty: number
  newQty: number
  timestamp: string
}

export interface AdminMe {
  userId: string
  roles: string[]
  storeName: string
  environment: string
}

export interface DashboardStats {
  today: {
    orderCount: number
    revenueMinor: number
    itemsShipped: number
  }
  recentOrders: Order[]
  lowStock: InventoryRow[]
}

export interface Notification {
  id: string
  type: 'info' | 'warning' | 'error'
  title: string
  message: string
  at: string
  read: boolean
}

// API response shapes
export interface LoginResponse {
  data: {
    customer: Customer
    tokens: {
      accessToken: string
      refreshToken: string
      expiresIn: number
    }
  }
}
