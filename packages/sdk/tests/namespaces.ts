import type { Address } from '@nymbalhq/types'
import type { NymbalClient } from '../src/index.js'

/** The client's six store namespaces, each with the `@nymbalhq/sdk/ns/<module>` that registers it. */
export const MODULE = {
  cart: 'cart',
  product: 'product',
  productList: 'product-list',
  search: 'search',
  checkout: 'checkout',
  auth: 'auth',
} as const

export type StoreKey = keyof typeof MODULE

export const STORE_KEYS = Object.keys(MODULE) as StoreKey[]

/** What reading a namespace whose module was never imported throws. */
export const missing = (key: StoreKey): string =>
  `client.${key} is not in this client: import '@nymbalhq/sdk/ns/${MODULE[key]}'`

/** A call on each store that changes its state, so a listener it still holds hears it. */
const POKE: { [K in StoreKey]: (store: NymbalClient[K]) => Promise<unknown> | void } = {
  cart: (s) => s.load(),
  product: (s) => s.loadBySlug('stub-product'),
  productList: (s) => s.load(),
  search: (s) => s.search('wool'),
  checkout: (s) => s.setEmail('poke@sdk.test'),
  auth: (s) => s.logout(),
}

export interface Listened {
  /** How many updates the store's listener has heard. */
  heard(): number
  /** Changes the store's state and waits for its call to finish. */
  poke(): Promise<void>
}

/** Subscribes a counting listener to a store the client built. */
export function listen<K extends StoreKey>(key: K, store: NymbalClient[K]): Listened {
  let heard = 0
  store.subscribe(() => {
    heard += 1
  })
  return {
    heard: () => heard,
    poke: async () => {
      await POKE[key](store)
    },
  }
}

export const address = {
  firstName: 'Ada',
  lastName: 'Buyer',
  addressLine1: '1 Stub Road',
  city: 'London',
  postalCode: 'N1 1AA',
  country: 'GB',
} as unknown as Address
