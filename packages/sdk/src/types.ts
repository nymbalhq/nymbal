import type {
  CartItem,
  CheckoutPayment,
  Customer,
  Address,
  Facet,
  Order,
  OrderStatus,
  PaymentIntent,
  ProductSortKey,
  VariantOption,
} from '@nymbalhq/types'

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
  sort: ProductSortKey
  pagination: { cursor: string | null; hasMore: boolean }
  loading: boolean
  error: string | null
}

export interface SearchState {
  query: string
  /** The category slug the search is narrowed to, or null for every category. */
  category: string | null
  /** Every page loaded so far, in rank order. */
  results: DenormalisedProduct[]
  /** The API's count of every match, not of the results loaded. */
  total: number
  /** The next page's cursor; null when every match is loaded. */
  nextCursor: string | null
  /** The search's facets: the category facet when search reports `facet` and the query matches. */
  facets: Facet[]
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
  /** What the server said about the payment; `succeeded` only once the order is paid. */
  paymentStatus: 'idle' | 'processing' | 'requires_action' | 'succeeded' | 'failed'
  error: string | null
  order: { orderId: string; orderNumber: string; paymentIntent: PaymentIntent } | null
  /** The order this cart already became, when the server refused a resubmit and named it. */
  placedOrderNumber: string | null
  /** That order's key, when the refusal carried one. */
  placedOrderKey: string | null
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
  sort?: ProductSortKey
}

export interface ProductListResult {
  items: DenormalisedProduct[]
  nextCursor: string | null
  facets?: Facet[]
}

export interface ProductSearchParams {
  limit?: number
  cursor?: string
  /** A category slug, as on the listing. */
  category?: string
}

export interface ProductSearchResult {
  items: DenormalisedProduct[]
  nextCursor: string | null
  total: number
  facets: Facet[]
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
  orderStatus: OrderStatus
  payment: CheckoutPayment
  /** Reads the order with no session (`customer.orders.get(n, { key })`); absent from an API that mints none. */
  orderKey?: string
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

export type NewAddress = Address & { isDefaultBilling?: boolean; isDefaultShipping?: boolean }

export interface OrderPage {
  items: Order[]
  nextCursor: string | null
}
