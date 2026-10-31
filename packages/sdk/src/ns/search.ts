import { defineNamespace } from '../client.js'
import { createSearchStore } from '../store/search-store.js'

defineNamespace('search', ({ adapter }) => createSearchStore(adapter))
