import { client } from '../lib/client.js'
import { formatPrice } from '../lib/format.js'

const container = document.getElementById('cart-content')
if (!container) throw new Error('Missing #cart-content')

function renderCart() {
  const state = client.cart.getState()
  const items = state.items ?? []
  const currency = items[0]?.currency ?? 'GBP'

  if (items.length === 0) {
    container!.innerHTML = `
      <div class="cart-empty">
        <h1 class="cart-empty-title">Your cart is empty</h1>
        <p class="cart-empty-text">Looks like you haven't added anything yet.</p>
        <a href="/products" class="btn btn-primary" data-testid="continue-shopping">Continue Shopping</a>
      </div>
    `
    return
  }

  const subtotal = items.reduce(
    (sum: number, item: any) => sum + item.priceMinor * item.qty,
    0,
  )

  const itemsHtml = items
    .map(
      (item: any) => `
      <div class="cart-line-item" data-testid="cart-item-${item.variantId}">
        <img
          src="${item.imageUrl || `https://picsum.photos/seed/${item.productId}/200/200`}"
          alt="${item.productName}"
          class="cart-line-image"
          width="100"
          height="100"
          loading="lazy"
        />
        <div class="cart-line-info">
          <a href="/product/${item.productId}" class="cart-line-name">${item.productName}</a>
          ${item.variantName ? `<span class="cart-line-variant">${item.variantName}</span>` : ''}
          <span class="cart-line-price-each">${formatPrice(item.priceMinor, currency)} each</span>
          <button
            type="button"
            class="cart-line-remove"
            data-variant-id="${item.variantId}"
            data-testid="cart-remove-${item.variantId}"
          >
            Remove
          </button>
        </div>
        <div class="cart-line-quantity">
          <button
            type="button"
            class="cart-line-quantity-btn"
            data-action="decrement"
            data-variant-id="${item.variantId}"
            aria-label="Decrease quantity"
          >-</button>
          <span class="cart-line-quantity-value">${item.qty}</span>
          <button
            type="button"
            class="cart-line-quantity-btn"
            data-action="increment"
            data-variant-id="${item.variantId}"
            aria-label="Increase quantity"
          >+</button>
        </div>
        <span class="cart-line-total">${formatPrice(item.priceMinor * item.qty, currency)}</span>
      </div>
    `,
    )
    .join('')

  container!.innerHTML = `
    <div class="cart-layout">
      <div>
        <div class="cart-header">
          <h1 class="cart-title">Your Cart <span class="cart-item-count">(${items.length} ${items.length === 1 ? 'item' : 'items'})</span></h1>
        </div>
        <div class="cart-items" data-testid="cart-items">
          ${itemsHtml}
        </div>
      </div>
      <div class="cart-summary" data-testid="cart-summary">
        <h2 class="cart-summary-title">Order Summary</h2>
        <dl>
          <div class="cart-summary-row">
            <dt>Subtotal</dt>
            <dd>${formatPrice(subtotal, currency)}</dd>
          </div>
          <div class="cart-summary-row">
            <dt>Shipping</dt>
            <dd>Calculated at checkout</dd>
          </div>
        </dl>
        <div class="cart-summary-total">
          <span>Estimated Total</span>
          <span>${formatPrice(subtotal, currency)}</span>
        </div>
        <div class="cart-summary-actions">
          <a href="/checkout" class="btn btn-primary" data-testid="checkout-btn">Proceed to Checkout</a>
          <a href="/products" class="btn btn-secondary">Continue Shopping</a>
        </div>
      </div>
    </div>
  `

  bindCartActions()
}

function bindCartActions() {
  container!.querySelectorAll('.cart-line-remove').forEach((btn) => {
    btn.addEventListener('click', () => {
      const variantId = (btn as HTMLElement).dataset.variantId
      if (variantId) client.cart.removeItem(variantId)
    })
  })

  container!.querySelectorAll('.cart-line-quantity-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const el = btn as HTMLElement
      const variantId = el.dataset.variantId
      const action = el.dataset.action
      if (!variantId) return

      const state = client.cart.getState()
      const item = (state.items ?? []).find((i: any) => i.variantId === variantId)
      if (!item) return

      if (action === 'increment') {
        client.cart.updateQuantity(variantId, item.qty + 1)
      } else if (action === 'decrement') {
        if (item.qty <= 1) {
          client.cart.removeItem(variantId)
        } else {
          client.cart.updateQuantity(variantId, item.qty - 1)
        }
      }
    })
  })
}

client.cart.subscribe(renderCart)
renderCart()
