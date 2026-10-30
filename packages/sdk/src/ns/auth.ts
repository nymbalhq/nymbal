import { defineNamespace } from '../client.js'
import { createAuthStore } from '../store/auth-store.js'

defineNamespace('auth', ({ adapter, tokenManager }) => createAuthStore(adapter, tokenManager))
