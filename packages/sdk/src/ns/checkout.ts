import './cart.js'
import { defineNamespace } from '../client.js'
import { createCheckoutStore } from '../store/checkout-store.js'

// The checkout places its order on the client's own cart, so one cart serves both.
defineNamespace('checkout', ({ adapter, client }) => createCheckoutStore(adapter, client.cart))
