import '../lib/client.js'

// Navigate to checkout when the cart drawer checkout button is clicked
document.addEventListener('nymbal:cart:checkout-clicked', () => {
  window.location.href = '/checkout'
})
