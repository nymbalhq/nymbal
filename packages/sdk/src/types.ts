import type {
  CartCodes,
  CartItem,
  CheckoutPayment,
  CheckoutQuote,
  CheckoutTotals,
  Customer,
  Address,
  Facet,
  Order,
  OrderStatus,
  PaymentIntent,
  ProductRating,
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
  /** The product's own page title and meta description; '' when the merchant has set none. */
  seoTitle: string
  seoDescription: string
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
  /** Served by the product routes, not stored: null when the product has no approved review. */
  rating?: ProductRating | null
}

// --- Store state types -----------------------------------------------------

export interface CartState {
  items: CartItem[]
  subtotalMinor: number
  currency: string
  itemCount: number
  /** What the cart comes to, codes' discount included, as the API last said; null before its first answer. */
  totals: CheckoutTotals | null
  /** What the engine said of each code on the cart. */
  promotions: CartCodes
  loading: boolean
  error: string | null
  /** The API's code for `error` (`cart.code_limit`, …), null when there is none or no API answer gave it. */
  errorCode: string | null
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

export interface CheckoutState {
  step: CheckoutStep
  email: string
  shippingAddress: Address | null
  billingAddress: Address | null
  /** The checkout priced for the shipping address and the chosen option: what Place Order acknowledges. */
  quote: CheckoutQuote | null
  /** A quote request is in flight; Place Order waits for its answer. */
  quoting: boolean
  /** What the server said about the payment; `succeeded` only once the order is paid. */
  paymentStatus: 'idle' | 'processing' | 'requires_action' | 'succeeded' | 'failed'
  error: string | null
  /** The API's code for `error` (`auth.token_invalid`, …), null when the error came from no API answer. */
  errorCode: string | null
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
  /** Marks the search page's own request, the one a miss is counted from. Everything else leaves it out. */
  origin?: 'page'
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
  /** The delivery option from the quote. */
  shippingOptionId?: string
  /** The total the shopper was shown: the server refuses to charge any other. */
  expectedTotalMinor?: number
}

export interface CheckoutQuoteDetails {
  shippingAddress: Address
  shippingOptionId?: string
  email?: string
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

/** A register on a store that confirms addresses: a link was mailed, and nobody is signed in until it is followed. */
export interface VerificationSent {
  verification: 'sent'
  expiresHours: number
}

export type NewAddress = Address & { isDefaultBilling?: boolean; isDefaultShipping?: boolean }

export interface OrderPage {
  items: Order[]
  nextCursor: string | null
}
