import { defineConfig } from 'astro/config'
import node from '@astrojs/node'

// NYMBAL_STOREFRONT_PORT lets `nymbal dev` (and a developer) pick a free port
// when the default 4321 is taken by another project. The `astro dev --port`
// flag still overrides this, so `nymbal dev` (which passes --port explicitly)
// always wins; this default just keeps a bare `pnpm dev` from hard-binding 4321.
const port = Number(process.env.NYMBAL_STOREFRONT_PORT) || 4321

export default defineConfig({
  output: 'server',
  adapter: node({ mode: 'standalone' }),
  server: { port },
})
