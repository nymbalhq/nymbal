import { defineNamespace } from '../client.js'
import { createCartStore } from '../store/cart-store.js'

defineNamespace('cart', ({ adapter }) => createCartStore(adapter))
