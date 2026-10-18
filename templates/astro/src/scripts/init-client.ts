import '../lib/client.js'

// Navigate to checkout when the cart drawer checkout button is clicked
document.addEventListener('nymbal:cart:checkout-clicked', () => {
  window.location.href = '/checkout'
})

// Choosing a header search suggestion (click or Enter) opens that product
document.addEventListener('nymbal:search:selected', ((
  e: CustomEvent<{ product?: { slug?: string } }>,
) => {
  const slug = e.detail?.product?.slug
  if (slug) {
    window.location.href = `/product/${encodeURIComponent(slug)}`
  }
}) as EventListener)
