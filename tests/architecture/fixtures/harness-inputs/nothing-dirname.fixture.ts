// Reads: nothing
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// Declares nothing and reads the ratchet from a root built on import.meta.dirname.

export const ratchet = (): string =>
  readFileSync(join(join(import.meta.dirname, '..', '..'), 'mutation-ratchet.json'), 'utf8')
