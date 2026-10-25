import type {
  AlertKind,
  Cart,
  Customer,
  CustomerAddress,
  ReviewsResult,
  ReviewResult,
  ShopperOrder,
  StoreCapabilities,
} from '@nymbalhq/types'
import type {
  DenormalisedProduct,
  ProductListParams,
  ProductListResult,
  ProductSearchParams,
  ProductSearchResult,
  CheckoutDetails,
  CheckoutResult,
  RegisterParams,
  AuthResult,
  NewAddress,
  OrderPage,
} from '../types.js'

export interface CommerceAdapter {
  /** What the store can do (GET /api/capabilities); an adapter without it cannot tell the storefront. */
  capabilities?: {
    get(): Promise<StoreCapabilities>
  }
  cart: {
    get(): Promise<Cart>
    addItem(variantId: string, qty: number): Promise<Cart>
    removeItem(variantId: string): Promise<Cart>
    updateQuantity(variantId: string, qty: number): Promise<Cart>
    clear(): Promise<Cart>
  }
  products: {
    getBySlug(slug: string): Promise<DenormalisedProduct>
    list(params?: ProductListParams): Promise<ProductListResult>
    search(query: string, params?: ProductSearchParams): Promise<ProductSearchResult>
  }
  checkout: {
    create(details: CheckoutDetails): Promise<CheckoutResult>
  }
  customers: {
    register(params: RegisterParams): Promise<AuthResult>
    login(email: string, password: string): Promise<AuthResult>
    logout(): Promise<void>
    refresh(): Promise<{ accessToken: string; expiresIn: number }>
    getProfile(): Promise<Customer>
    updateProfile(
      updates: Partial<Pick<Customer, 'firstName' | 'lastName' | 'phone'>>,
    ): Promise<Customer>
    listAddresses(): Promise<CustomerAddress[]>
    addAddress(address: NewAddress): Promise<CustomerAddress>
    removeAddress(id: string): Promise<void>
    listOrders(params?: { cursor?: string }): Promise<OrderPage>
    /** `key` is the order's key from its checkout, for a reader with no session. */
    getOrder(orderNumber: string, options?: { key?: string }): Promise<ShopperOrder>
  }
  reviews: {
    getForProduct(
      productId: string,
      params?: { limit?: number; cursor?: string },
    ): Promise<ReviewsResult>
    submit(review: {
      productId: string
      rating: number
      title: string
      body: string
    }): Promise<ReviewResult>
  }
  alerts: {
    /**
     * Asks to be emailed when a variant is back; the store mails a confirmation first. The answer is `pending` whether
     * or not the address has an account or an alert already.
     */
    subscribe(request: {
      email: string
      variantId: string
      kind: AlertKind
    }): Promise<{ status: 'pending' }>
  }
}
