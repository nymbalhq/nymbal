import { readFile, realpath, stat } from 'node:fs/promises'
import { extname, resolve, sep } from 'node:path'
import type { HttpAdapter, ResponseEnvelope } from '@nymbalhq/types'

const MIME = new Map<string, string>([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.ico', 'image/x-icon'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.ttf', 'font/ttf'],
])

const BUILD_HINT =
  'The Nymbal admin is not built. Run `pnpm --filter @nymbalhq/admin build` in the Nymbal repository, ' +
  'or install the `@nymbalhq/admin` package beside `nymbal`.\n'

const notFound = (body = 'Not found\n'): ResponseEnvelope => ({
  status: 404,
  headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' },
  body,
})

/** The file under `root` that a request path names, or null when it names nothing inside the root. */
async function fileWithin(root: string, requestPath: string): Promise<string | null> {
  if (requestPath.includes('\0') || requestPath.includes('\\')) return null
  const candidate = resolve(root, `.${sep}${requestPath}`)
  if (candidate !== root && !candidate.startsWith(root + sep)) return null
  try {
    if (!(await stat(candidate)).isFile()) return null
    // A symlink inside the root may point outside it.
    const real = await realpath(candidate)
    return real.startsWith(root + sep) ? real : null
  } catch {
    return null
  }
}

/**
 * Serves the admin's built files at /admin/ beside /api, one origin, so its relative API URLs and the refresh cookie
 * work without a proxy. `root` is the admin's dist directory, or null when none is installed: then /admin/ answers 404
 * with how to build it.
 */
export function registerAdminStaticRoute(adapter: HttpAdapter, root: string | null): void {
  adapter.registerRoute('GET', '/admin', async () => ({
    status: 308,
    headers: { Location: '/admin/' },
    body: undefined,
  }))

  let realRoot: Promise<string | null> | null = null
  const resolvedRoot = (): Promise<string | null> =>
    (realRoot ??= root === null ? Promise.resolve(null) : realpath(root).catch(() => null))

  const serve = async (wildcard: string): Promise<ResponseEnvelope> => {
    const base = await resolvedRoot()
    if (base === null) return notFound(BUILD_HINT)

    const requestPath = wildcard === '' ? 'index.html' : wildcard
    const file = await fileWithin(base, requestPath)
    if (file !== null) {
      const ext = extname(file).toLowerCase()
      return {
        status: 200,
        headers: {
          'Content-Type': MIME.get(ext) ?? 'application/octet-stream',
          'Cache-Control': requestPath.startsWith('assets/')
            ? 'public, max-age=31536000, immutable'
            : 'no-cache',
        },
        body: await readFile(file),
      }
    }

    // A missing asset is a 404; anything else is a client-side route, answered with the app.
    if (MIME.has(extname(requestPath).toLowerCase())) return notFound()
    const index = await fileWithin(base, 'index.html')
    if (index === null) return notFound(BUILD_HINT)
    return {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' },
      body: await readFile(index),
    }
  }

  adapter.registerRoute('GET', '/admin/', () => serve(''))
  adapter.registerRoute('GET', '/admin/*', (ctx) => serve(ctx.params['*'] ?? ''))
}
