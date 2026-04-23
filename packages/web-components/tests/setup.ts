import { beforeEach, afterEach } from 'vitest'
import { registerComponents } from '../src/index.js'
import { resetMockClient } from '../src/testing/index.js'

// Register components once — guarded against re-registration in registerComponents()
registerComponents()

beforeEach(() => {
  resetMockClient()
})

afterEach(() => {
  // Clean up any elements added to document body during tests
  document.body.innerHTML = ''
})
