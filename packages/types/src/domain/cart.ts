export interface CartItem {
  variantId: string
  productId: string
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
