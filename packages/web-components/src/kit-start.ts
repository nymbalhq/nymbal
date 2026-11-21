import { createNymbalClient } from '@nymbalhq/sdk/core'
import '@nymbalhq/sdk/ns/cart'
import { NymbalAddToCart } from './components/add-to-cart.js'
import { NymbalCartDrawer } from './components/cart-drawer.js'
import { NymbalMiniCart } from './components/mini-cart.js'
import { NymbalNotifyMe } from './components/notify-me.js'
import { NymbalQuantitySelector } from './components/quantity-selector.js'
import { NymbalToast } from './components/toast.js'
import { define } from './define.js'
import { registerClient } from './registry.js'

export type KitResult = 'started' | 'misconfigured' | 'unreachable' | 'cross-site'

const API_META = 'nymbal:api-url'
const STORE_META = 'nymbal:store-url'
const FAILED_CHANGE = 'We could not update your cart. Please try again.'

function metaUrl(name: string): URL | null {
  const content = document.querySelector(`meta[name="${name}"]`)?.getAttribute('content') ?? ''
  if (!/^https?:\/\//i.test(content)) return null
  try {
    return new URL(content)
  } catch {
    return null
  }
}

/** The token one `GET /api/csrf` answers, or null when the API cannot be read from this page. */
async function probe(api: string): Promise<string | null> {
  try {
    const res = await fetch(`${api}/api/csrf`, { credentials: 'include' })
    if (!res.ok) return null
    const body = (await res.json()) as { data?: { token?: unknown } }
    return typeof body.data?.token === 'string' && body.data.token !== '' ? body.data.token : null
  } catch {
    return null
  }
}

function appendWhenAbsent(tag: string): void {
  if (document.querySelector(tag) === null) document.body.append(document.createElement(tag))
}

/** The add button in the nearest container of `from` that holds one; `body` is no container. */
function nearestAddButton(from: Element): Element | null {
  for (let el = from.parentElement; el !== null && el !== document.body; el = el.parentElement) {
    const button = el.querySelector('nymbal-add-to-cart')
    if (button !== null) return button
  }
  return null
}

async function defineNotifyMe(client: ReturnType<typeof createNymbalClient>): Promise<void> {
  if (document.querySelector('nymbal-notify-me') === null) return
  try {
    const capabilities = await client.capabilities.get()
    if (capabilities.email.delivers) define(NymbalNotifyMe)
  } catch {
    // The form stays undefined, as on a store that sends no mail: a shopper gets no form that cannot work.
  }
}

/**
 * Starts the elements on a page that is not a Nymbal storefront. Everything waits for the probe: a set-up that cannot
 * work says why in the console, and neither takes a click nor mints a cart per page view.
 */
export async function startKit(): Promise<KitResult> {
  const apiUrl = metaUrl(API_META)
  if (apiUrl === null) {
    console.error(`Nymbal: <meta name="${API_META}"> is missing or not an absolute http(s) URL.`)
    return 'misconfigured'
  }
  const storeUrl = metaUrl(STORE_META)
  if (storeUrl === null) {
    console.error(`Nymbal: <meta name="${STORE_META}"> is missing or not an absolute http(s) URL.`)
    return 'misconfigured'
  }
  const api = apiUrl.href.replace(/\/+$/, '')

  const first = await probe(api)
  const second = first === null ? null : await probe(api)
  if (first === null || second === null) {
    console.error(
      `Nymbal: ${location.origin} cannot read ${api}/api/csrf. Is the API up, and is ${location.origin} in http.cors.kitOrigins or http.cors.allowedOrigins?`,
    )
    return 'unreachable'
  }
  // The API echoes a token whose cookie came back and mints a new one when none did.
  if (first !== second) {
    console.error(
      `Nymbal: the API's cookie does not come back from ${apiUrl.origin} to ${location.origin}. The site and the API must share one registrable domain.`,
    )
    return 'cross-site'
  }

  const client = createNymbalClient({ baseUrl: api })
  // An alert mail's links must reach the store, not this site. Here, not in the SDK: every storefront carries the SDK.
  const { alerts } = client.adapter
  const subscribe = alerts.subscribe
  alerts.subscribe = (request) =>
    subscribe({ ...request, linkOrigin: storeUrl.origin } as typeof request)
  registerClient(client)
  define(NymbalAddToCart, NymbalMiniCart, NymbalCartDrawer, NymbalQuantitySelector, NymbalToast)

  appendWhenAbsent('nymbal-cart-drawer')
  appendWhenAbsent('nymbal-toast')

  document.addEventListener('nymbal:cart:checkout-clicked', () => {
    location.href = new URL('/checkout', storeUrl).href
  })
  document.addEventListener('nymbal:quantity:changed', (event) => {
    if (!(event.target instanceof Element)) return
    const { value } = (event as CustomEvent<{ value: number }>).detail
    nearestAddButton(event.target)?.setAttribute('qty', String(value))
  })

  await defineNotifyMe(client)
  await client.cart.load()

  // After the load, whose own failure stays quiet: a plain page view changed no cart.
  let shown = client.cart.getState().error
  client.cart.subscribe(() => {
    const { error } = client.cart.getState()
    if (shown === null && error !== null) NymbalToast.showGlobal(FAILED_CHANGE, 'error')
    shown = error
  })
  return 'started'
}
