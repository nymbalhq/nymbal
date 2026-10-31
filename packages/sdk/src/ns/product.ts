import { defineNamespace } from '../client.js'
import { createProductStore } from '../store/product-store.js'

defineNamespace('product', ({ adapter }) => createProductStore(adapter))
