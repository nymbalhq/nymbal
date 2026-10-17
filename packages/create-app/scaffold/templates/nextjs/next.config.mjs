/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@nymbalhq/sdk', '@nymbalhq/react', '@nymbalhq/web-components'],
  images: {
    remotePatterns: [{ protocol: 'https', hostname: '**' }],
  },
}
export default nextConfig
