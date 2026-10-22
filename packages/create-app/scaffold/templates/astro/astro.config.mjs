import { fileURLToPath } from 'node:url'
import { defineConfig } from 'astro/config'
import node from '@astrojs/node'

const OWN_ELEMENTS = fileURLToPath(new URL('./src/elements/index.ts', import.meta.url))

/**
 * NYMBAL_ELEMENTS_ENTRY (an absolute path) is the store's elements entry in place of src/elements/index.ts, on the
 * server and in the browser (the E2E override fixture).
 */
function elementsEntry(entry) {
  return {
    name: 'nymbal-elements-entry',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (importer === undefined || importer === entry) return null
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true })
      return resolved?.id === OWN_ELEMENTS ? entry : null
    },
  }
}
const elementsEntryPath = process.env.NYMBAL_ELEMENTS_ENTRY

// NYMBAL_STOREFRONT_PORT lets `nymbal dev` (and a developer) pick a free port
// when the default 4321 is taken by another project. The `astro dev --port`
// flag still overrides this, so `nymbal dev` (which passes --port explicitly)
// always wins; this default just keeps a bare `pnpm dev` from hard-binding 4321.
const port = Number(process.env.NYMBAL_STOREFRONT_PORT) || 4321

export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  server: { port },
  // The page's CSS travels in its HTML, so the first paint waits on no stylesheet request (perf-budgets.json: LCP).
  build: { inlineStylesheets: 'always' },
  vite: { plugins: elementsEntryPath ? [elementsEntry(elementsEntryPath)] : [] },
})
