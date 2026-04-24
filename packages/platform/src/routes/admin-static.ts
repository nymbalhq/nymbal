import { existsSync, statSync, readFileSync } from 'node:fs'
import { join, extname } from 'node:path'
import type { HttpAdapter } from '@nymbal/types'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.mjs': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
}

export function registerAdminStaticRoute(adapter: HttpAdapter, distPath: string): void {
  adapter.registerRoute('GET', '/admin', async (_ctx) => {
    return { status: 302, headers: { Location: '/admin/' }, body: undefined }
  })

  adapter.registerRoute('GET', '/admin/*', async (ctx) => {
    const urlPath = (ctx.params as Record<string, string>)['*'] ?? ''
    const requestedFile = urlPath ? `/${urlPath}` : '/index.html'

    // Try to serve the actual file
    const fullPath = join(distPath, requestedFile)
    if (existsSync(fullPath) && statSync(fullPath).isFile()) {
      const ext = extname(fullPath).toLowerCase()
      const contentType = MIME[ext] ?? 'application/octet-stream'
      const isAsset = requestedFile.startsWith('/assets/')
      const cacheControl = isAsset
        ? 'public, max-age=31536000, immutable'
        : 'no-cache, no-store'
      const isText =
        ext === '.html' ||
        ext === '.css' ||
        ext === '.js' ||
        ext === '.mjs' ||
        ext === '.json' ||
        ext === '.svg'
      const content = readFileSync(fullPath)
      return {
        status: 200,
        headers: { 'Content-Type': contentType, 'Cache-Control': cacheControl },
        body: isText ? content.toString('utf8') : content.toString('base64'),
      }
    }

    // SPA fallback — serve index.html for all non-file routes
    const indexPath = join(distPath, 'index.html')
    if (existsSync(indexPath)) {
      const content = readFileSync(indexPath, 'utf8')
      return {
        status: 200,
        headers: {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache, no-store',
        },
        body: content,
      }
    }

    return {
      status: 503,
      headers: { 'Content-Type': 'text/plain' },
      body: 'Admin not built. Run: pnpm --filter @nymbal/admin build',
    }
  })
}
