// A media adapter as a third party ships one, plain JavaScript with no dependency: it keeps what it is given in memory
// and serves it from the `publicUrl` its block's config names.

export const slot = 'media'
export const provider = 'acme'

export function createAdapter(ctx) {
  const publicUrl = String(ctx?.config?.publicUrl ?? 'https://media.acme.test')
  const objects = new Map()
  return {
    capabilities: () => ['put'],
    async put(key, body) {
      objects.set(key, body)
      return { url: `${publicUrl}/${key}` }
    },
    healthCheck: async () => ({ status: 'healthy' }),
  }
}
