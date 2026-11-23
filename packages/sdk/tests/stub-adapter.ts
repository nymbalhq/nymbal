import type {
  CartCodeStatus,
  CartItem,
  Customer,
  CustomerAddress,
  ShopperOrder,
  ShopperCart,
  StoreCapabilities,
} from '@nymbalhq/types'
import type { CommerceAdapter } from '../src/adapter/commerce-adapter.js'
import type { CheckoutResult, DenormalisedProduct, OrderPage } from '../src/types.js'

/** What the stub answers; each test sets the part it reads back through a store. */
export interface StubData {
  cartItems: CartItem[]
  /** The cart's codes, each accepted and moving no money. */
  cartCodes: string[]
  product: DenormalisedProduct
  listed: DenormalisedProduct[]
  found: DenormalisedProduct[]
  customer: Customer
  addresses: CustomerAddress[]
  capabilities: StoreCapabilities
  order: ShopperOrder
  viewed: DenormalisedProduct[]
}

export function product(slug: string): DenormalisedProduct {
  return {
    id: `id-${slug}`,
    slug,
    name: slug,
    description: '',
    shortDescription: '',
    status: 'active',
    type: 'simple',
    brand: '',
    media: [],
    variantCount: 1,
    inStock: true,
    priceRange: { minMinor: 100, maxMinor: 100 },
    priceMinor: 100,
    currency: 'GBP',
    variants: [],
    categoryIds: [],
    categories: [],
    createdAt: '2026-10-30T00:00:00.000Z',
    updatedAt: '2026-10-30T00:00:00.000Z',
  } as unknown as DenormalisedProduct
}

export function cartItem(variantId: string, qty: number): CartItem {
  return {
    variantId,
    productId: `p-${variantId}`,
    productName: variantId,
    variantName: 'Default',
    priceMinor: 250,
    qty,
    imageUrl: '',
  }
}

export function defaultData(): StubData {
  return {
    cartItems: [],
    cartCodes: [],
    product: product('stub-product'),
    listed: [product('listed')],
    found: [product('found')],
    customer: {
      id: 'cus-stub',
      email: 'stub@sdk.test',
      firstName: 'Stub',
      lastName: 'Shopper',
    } as unknown as Customer,
    addresses: [],
    capabilities: { payments: [] } as unknown as StoreCapabilities,
    order: { orderNumber: 'NYM-STUB' } as unknown as ShopperOrder,
    viewed: [],
  }
}

/** An in-memory adapter: no network, every call answers from `data` at the time it is made. */
export function stubAdapter(data: StubData = defaultData()): CommerceAdapter {
  const cart = (): ShopperCart => {
    const subtotalMinor = data.cartItems.reduce((sum, i) => sum + i.priceMinor * i.qty, 0)
    return {
      token: 'cart-stub',
      customerId: null,
      items: data.cartItems,
      subtotalMinor,
      currency: 'GBP',
      source: 'storefront',
      expiresAt: '2026-11-30T00:00:00.000Z',
      createdAt: '2026-10-30T00:00:00.000Z',
      updatedAt: '2026-10-30T00:00:00.000Z',
      totals: {
        currency: 'GBP',
        subtotalMinor,
        discountTotalMinor: 0,
        shippingTotalMinor: 0,
        shippingDiscountMinor: 0,
        taxTotalMinor: 0,
        totalMinor: subtotalMinor,
        pricesIncludeTax: false,
        lines: [],
        applied: [],
      },
      promotions: {
        codes: data.cartCodes.map((code): CartCodeStatus => ({ code, status: 'accepted' })),
        unavailable: false,
      },
    }
  }
  const auth = async () => ({ customer: data.customer, accessToken: 'token-stub', expiresIn: 900 })
  const placed: CheckoutResult = {
    orderId: 'ord-stub',
    orderNumber: 'NYM-STUB',
    paymentIntent: { id: 'pi-stub' },
    currency: 'GBP',
    totalMinor: 0,
    orderStatus: 'paid',
    payment: { status: 'succeeded' },
  } as unknown as CheckoutResult
  return {
    capabilities: { get: async () => data.capabilities },
    orders: { get: async () => data.order, requestLink: async () => {} },
    recentlyViewed: { record: async () => {}, list: async () => ({ items: data.viewed }) },
    cart: {
      get: async () => cart(),
      addItem: async () => cart(),
      removeItem: async () => cart(),
      updateQuantity: async () => cart(),
      clear: async () => cart(),
      addCode: async (code: string) => {
        const lower = code.toLowerCase()
        if (!data.cartCodes.some((c) => c.toLowerCase() === lower)) data.cartCodes.push(code)
        return cart()
      },
      removeCode: async (code: string) => {
        const lower = code.toLowerCase()
        data.cartCodes = data.cartCodes.filter((c) => c.toLowerCase() !== lower)
        return cart()
      },
    },
    products: {
      getBySlug: async () => data.product,
      list: async () => ({ items: data.listed, nextCursor: null, facets: [] }),
      search: async () => ({
        items: data.found,
        nextCursor: null,
        total: data.found.length,
        facets: [],
      }),
    },
    checkout: {
      create: async () => placed,
      // The one free option at the goods' total: a store with no shipping table.
      quote: async () => ({
        currency: 'GBP',
        options: [{ id: 'standard', name: 'Standard', amountMinor: 0, estimatedDays: null }],
        shippingOptionId: 'standard',
        totals: {
          currency: 'GBP',
          subtotalMinor: 0,
          discountTotalMinor: 0,
          shippingTotalMinor: 0,
          shippingDiscountMinor: 0,
          taxTotalMinor: 0,
          totalMinor: 0,
          pricesIncludeTax: false,
          lines: [],
          applied: [],
        },
      }),
    },
    customers: {
      register: auth,
      login: auth,
      requestPasswordReset: async () => {},
      resetPassword: auth,
      verifyEmail: auth,
      resendVerification: async () => {},
      changePassword: auth,
      logout: async () => {},
      listSessions: async () => [],
      endSession: async () => ({ ended: true, current: false }),
      endAllSessions: async () => {},
      refresh: async () => ({ accessToken: 'token-stub', expiresIn: 900 }),
      getProfile: async () => data.customer,
      updateProfile: async () => data.customer,
      listAddresses: async () => data.addresses,
      addAddress: async (address) => ({ id: 'adr-stub', ...address }) as unknown as CustomerAddress,
      removeAddress: async () => {},
      listOrders: async (): Promise<OrderPage> => ({ items: [], nextCursor: null }),
      getOrder: async () => data.order,
    },
    reviews: {
      getForProduct: async () => ({ items: [], nextCursor: null }) as never,
      submit: async () => ({}) as never,
    },
    alerts: { subscribe: async () => ({ status: 'pending' as const }) },
  }
}
