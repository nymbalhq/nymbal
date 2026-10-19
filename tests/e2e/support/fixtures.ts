import { test as base, expect, type Page } from '@playwright/test'

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

function isLocalUrl(url: URL): boolean {
  if (url.protocol === 'data:' || url.protocol === 'blob:' || url.protocol === 'about:') return true
  if (!LOCAL_HOSTS.has(url.hostname)) return false
  // Next.js serves remote images through its optimizer, which fetches the remote host server-side
  if (url.pathname === '/_next/image') {
    const target = url.searchParams.get('url')
    if (target && /^[a-z][a-z0-9+.-]*:/i.test(target)) return isLocalUrl(new URL(target))
  }
  return true
}

/**
 * Aborts every request to a host other than localhost (AC-12), so screenshots do not depend on the network.
 * Call before the first navigation.
 */
export async function blockExternalRequests(page: Page): Promise<void> {
  await page.route((url) => !isLocalUrl(url), (route) => route.abort('blockedbyclient'))
}

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
