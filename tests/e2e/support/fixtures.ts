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
