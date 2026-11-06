// Reads: nothing
import { readFileSync } from 'node:fs'

// Declares nothing and reads through a template URL resolved against its own.

export const named = (name: string): string =>
  readFileSync(new URL(`../../../../${name}`, import.meta.url), 'utf8')
