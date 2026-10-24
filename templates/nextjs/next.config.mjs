import { relative } from 'node:path'
import { fileURLToPath } from 'node:url'

// NYMBAL_ELEMENTS_ENTRY (an absolute path) is the store's elements entry in place of elements/index.ts, on the server
// and in the browser (the E2E override fixture).
const elementsEntry = process.env.NYMBAL_ELEMENTS_ENTRY
const elementsAlias =
  elementsEntry === undefined
    ? {}
    : { '@/elements': `./${relative(fileURLToPath(new URL('.', import.meta.url)), elementsEntry)}` }

// NYMBAL_NEXT_DIST_DIR builds beside the usual `.next`, so a second build cannot overwrite one being served.
const distDir = process.env.NYMBAL_NEXT_DIST_DIR || '.next'

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  distDir,
  ...(distDir !== '.next' && { typescript: { tsconfigPath: 'tsconfig.dist.json' } }),
  // Cached pages live in memory, bounded by cacheMaxMemorySize: on disk, every distinct product URL a crawler asks for
  // would keep an entry.
  experimental: { isrFlushToDisk: false },
  // `/` and the header and nav fragments are dynamic segments with no params, so the build prerenders none of them
  // (the API may be down then) and Next caches each on its first request.
  async rewrites() {
    return {
      beforeFiles: [
        { source: '/', destination: '/home/index' },
        { source: '/fragments/header', destination: '/fragments/header/index' },
        { source: '/fragments/nav', destination: '/fragments/nav/index' },
      ],
    }
  },
  transpilePackages: ['@nymbalhq/sdk', '@nymbalhq/react', '@nymbalhq/web-components'],
  images: {
    remotePatterns: [{ protocol: 'https', hostname: '**' }],
  },
  turbopack: { resolveAlias: elementsAlias },
}

export default nextConfig
