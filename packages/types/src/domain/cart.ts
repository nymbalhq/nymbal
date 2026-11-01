/** The most of one variant a cart line holds. */
export const CART_LINE_MAX_QTY = 99

export interface CartItem {
  variantId: string
  productId: string
  /** The product page's slug; lines stored before lines carried one have none. */
  productSlug?: string
  productName: string
  variantName: string
  priceMinor: number
  qty: number
  imageUrl: string
}

export interface Cart {
  token: string
  customerId: string | null
  items: CartItem[]
  subtotalMinor: number
  currency: string
  expiresAt: string
  createdAt: string
  updatedAt: string
}
