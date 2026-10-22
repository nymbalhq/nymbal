import { relative } from 'node:path'
import { fileURLToPath } from 'node:url'

// NYMBAL_ELEMENTS_ENTRY (an absolute path) is the store's elements entry in place of elements/index.ts, on the server
// and in the browser (the E2E override fixture).
const elementsEntry = process.env.NYMBAL_ELEMENTS_ENTRY
const elementsAlias =
  elementsEntry === undefined
    ? {}
    : { '@/elements': `./${relative(fileURLToPath(new URL('.', import.meta.url)), elementsEntry)}` }

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@nymbalhq/sdk', '@nymbalhq/react', '@nymbalhq/web-components'],
  images: {
    remotePatterns: [{ protocol: 'https', hostname: '**' }],
  },
  turbopack: { resolveAlias: elementsAlias },
}

export default nextConfig
