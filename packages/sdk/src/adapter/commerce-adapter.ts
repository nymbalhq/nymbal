import type { Cart, Customer } from '@nymbal/types'
import type {
  DenormalisedProduct,
  ProductListParams,
  ProductListResult,
  CheckoutDetails,
  CheckoutResult,
  RegisterParams,
  AuthResult,
  ReviewsListResult,
  ReviewSubmitResult,
} from '../types.js'

export interface CommerceAdapter {
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
    search(query: string, params?: { limit?: number; cursor?: string }): Promise<ProductListResult>
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
  }
  reviews: {
    getForProduct(
      productId: string,
      params?: { limit?: number; cursor?: string },
    ): Promise<ReviewsListResult>
    submit(review: {
      productId: string
      rating: number
      title: string
      body: string
    }): Promise<ReviewSubmitResult>
  }
}
