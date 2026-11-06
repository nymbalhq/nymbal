// Reads: nothing
import { readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// Declares nothing and lists its parent directory through a URL resolved against its own.

export const parent = (): string[] => readdirSync(fileURLToPath(new URL('..', import.meta.url)))
