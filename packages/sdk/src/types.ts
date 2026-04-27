import type {
  CartItem,
  Customer,
  Address,
  Facet,
  PaymentIntent,
  VariantOption,
} from '@nymbal/types'

// --- Denormalised product (matches platform document store projection) ------

export interface DenormalisedVariant {
  id: string
  sku: string
  name: string
  priceMinor: number
  stock: number
  options: VariantOption[]
}

export interface DenormalisedProduct {
  id: string
  slug: string
  name: string
  description: string
  shortDescription: string
  status: string
  type: string
  media: unknown
  variantCount: number
  inStock: boolean
  priceRange: { minMinor: number; maxMinor: number } | null
  currency: string | null
  priceMinor: number | null
  variants: DenormalisedVariant[]
  categoryIds: string[]
  categories: Array<{ id: string; name: string; slug: string }>
  createdAt: string
  updatedAt: string
}

// --- Store state types -----------------------------------------------------

export interface CartState {
  items: CartItem[]
  subtotalMinor: number
  currency: string
  itemCount: number
  loading: boolean
  error: string | null
}

export interface ProductState {
  product: DenormalisedProduct | null
  selectedVariant: DenormalisedVariant | null
  loading: boolean
  error: string | null
}

export interface ProductListState {
  products: DenormalisedProduct[]
  facets: Facet[]
  filters: Record<string, string | string[]>
  sort: { field: string; direction: 'asc' | 'desc' } | null
  pagination: { cursor: string | null; hasMore: boolean }
  loading: boolean
  error: string | null
}

export interface SearchState {
  query: string
  results: DenormalisedProduct[]
  total: number
  loading: boolean
}

export type CheckoutStep = 'contact' | 'shipping' | 'payment' | 'confirmation'

export interface ShippingMethod {
  carrier: string
  service: string
  amountMinor: number
  currency: string
  estimatedDays: number
}

export interface CheckoutState {
  step: CheckoutStep
  email: string
  shippingAddress: Address | null
  billingAddress: Address | null
  shippingMethod: ShippingMethod | null
  paymentStatus: 'idle' | 'processing' | 'succeeded' | 'failed'
  error: string | null
  order: { orderId: string; orderNumber: string; paymentIntent: PaymentIntent } | null
}

export interface AuthState {
  customer: Customer | null
  isAuthenticated: boolean
  loading: boolean
  error: string | null
}

// --- Adapter param/result types --------------------------------------------

export interface ProductListParams {
  limit?: number
  cursor?: string
  category?: string
}

export interface ProductListResult {
  items: DenormalisedProduct[]
  nextCursor: string | null
  facets?: Facet[]
}

export interface CheckoutDetails {
  email: string
  billingAddress: Address
  shippingAddress: Address
  notes?: string
}

export interface CheckoutResult {
  orderId: string
  orderNumber: string
  paymentIntent: PaymentIntent
  currency: string
  totalMinor: number
}

export interface RegisterParams {
  email: string
  password: string
  firstName?: string
  lastName?: string
  phone?: string
}

export interface AuthResult {
  customer: Customer
  accessToken: string
  expiresIn: number
}

