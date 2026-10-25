import type {
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
    getOrder(orderNumber: string): Promise<ShopperOrder>
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
}
