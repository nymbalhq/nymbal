import { test as base, expect } from '@playwright/test'

export const test = base.extend<{ autoFailOnErrors: void }>({
  autoFailOnErrors: [async ({ page }, use) => {
    const errors: string[] = []

    page.on('pageerror', (error) => {
      errors.push(`pageerror: ${error.message}`)
    })

    page.on('console', (msg) => {
      if (msg.type() === 'error') {
        const text = msg.text()
        if (text.includes('favicon.ico')) return
        // The browser auto-generates "Failed to load resource" console.errors for any
        // non-2xx HTTP response. These are browser-level messages, not application errors.
        // Real application errors are logged separately by the SDK with specific prefixes
        // (e.g. "[CartStore] load failed"). Filtering these prevents false positives for
        // expected HTTP errors like 401 on bad credentials or 404 on missing pages.
        if (text.startsWith('Failed to load resource:')) return
        errors.push(`console.error: ${text}`)
      }
    })

    await use()

    if (errors.length > 0) {
      throw new Error(
        `Page errors during test:\n${errors.map((e) => `  - ${e}`).join('\n')}`,
      )
    }
  }, { auto: true }],
})

export { expect }
