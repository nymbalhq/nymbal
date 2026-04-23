/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ['@nymbal/sdk', '@nymbal/react', '@nymbal/web-components'],
  images: {
    remotePatterns: [{ protocol: 'https', hostname: '**' }],
  },
}
export default nextConfig
