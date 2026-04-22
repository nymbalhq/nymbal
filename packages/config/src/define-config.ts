import type { NymbalConfigInput } from './schema.js'

export function defineConfig<T extends NymbalConfigInput>(config: T): T {
  return config
}
