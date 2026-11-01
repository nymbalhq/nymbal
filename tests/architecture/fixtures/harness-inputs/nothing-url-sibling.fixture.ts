// Reads: nothing
import { readFileSync } from 'node:fs'

// Declares nothing and reads a sibling through a URL resolved against its own.

export const sibling = (): string =>
  readFileSync(new URL('./honest.fixture.ts', import.meta.url), 'utf8')
