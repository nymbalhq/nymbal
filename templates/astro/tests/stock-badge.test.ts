import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import fc from 'fast-check'
import { Window } from 'happy-dom'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { getViteConfig } from 'astro/config'
import * as types from '@nymbalhq/types'

// P2-12 AC-4 (Astro): the PDP's stock badge, `src/components/StockBadge.astro`, rendered by Astro itself (its Vite
// plugin compiles the component, the Container API renders it to a string), carries `data-level` = stockLevel(stock)
// and the label STOCK_LABELS[level] for any stock, negatives included. Kills: the component keeping a rule or labels
// of its own instead of the one in @nymbalhq/types.

type Level = 'out' | 'low' | 'in'

const { stockLevel, STOCK_LABELS } = types as unknown as {
  stockLevel?: (stock: number) => Level
  STOCK_LABELS?: Record<Level, string>
}

const TEMPLATE = resolve(dirname(fileURLToPath(import.meta.url)), '..')

type Render = (component: unknown, options: { props: Record<string, unknown> }) => Promise<string>

interface DevServer {
  ssrLoadModule(id: string): Promise<Record<string, unknown>>
  close(): Promise<void>
}

let server: DevServer
let renderToString: Render
let StockBadge: unknown

beforeAll(async () => {
  // Astro's own Vite: the template does not depend on it directly, so it is found from Astro's package.
  const astroRequire = createRequire(realpathSync(join(TEMPLATE, 'node_modules/astro/package.json')))
  const vite = (await import(pathToFileURL(astroRequire.resolve('vite')).href)) as {
    createServer(config: Record<string, unknown>): Promise<DevServer>
  }
  const configFor = getViteConfig({ logLevel: 'silent' }, { root: TEMPLATE, logLevel: 'silent' }) as unknown as (env: {
    command: 'serve'
    mode: string
  }) => Promise<Record<string, unknown>>
  server = await vite.createServer({
    ...(await configFor({ command: 'serve', mode: 'test' })),
    configFile: false,
    root: TEMPLATE,
    appType: 'custom',
    server: { middlewareMode: true, hmr: false, ws: false },
  })
  StockBadge = (await server.ssrLoadModule('/src/components/StockBadge.astro')).default
  const { experimental_AstroContainer } = (await server.ssrLoadModule('astro/container')) as {
    experimental_AstroContainer: { create(): Promise<{ renderToString: Render }> }
  }
  const container = await experimental_AstroContainer.create()
  renderToString = container.renderToString.bind(container)
}, 60_000)

afterAll(async () => {
  await server?.close()
})

/** The rendered badge's level and label. */
function badge(html: string): { level: string | null; label: string } {
  const window = new Window()
  window.document.body.innerHTML = html
  const el = window.document.querySelector('[data-testid="stock-badge"]')
  const read = { level: el?.getAttribute('data-level') ?? null, label: el?.textContent?.trim() ?? '' }
  void window.happyDOM.close()
  return read
}

describe('P2-12: the Astro stock badge renders the one rule', () => {
  it('AC-4: StockBadge.astro renders data-level = stockLevel(stock) and the label STOCK_LABELS[level] for any stock, negatives included', async () => {
    expect(typeof stockLevel, '@nymbalhq/types exports stockLevel').toBe('function')
    await fc.assert(
      fc.asyncProperty(fc.oneof(fc.integer({ min: -20, max: 20 }), fc.integer()), async (stock) => {
        const level = stockLevel!(stock)
        const shown = badge(await renderToString(StockBadge, { props: { stock } }))
        expect(shown).toEqual({ level, label: STOCK_LABELS![level] })
      }),
      { numRuns: 60 },
    )
  })
})
