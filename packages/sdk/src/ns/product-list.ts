import { defineNamespace } from '../client.js'
import { createProductListStore } from '../store/product-list-store.js'

defineNamespace('productList', ({ adapter }) => createProductListStore(adapter))
