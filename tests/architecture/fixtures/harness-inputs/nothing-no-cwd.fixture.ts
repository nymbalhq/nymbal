// Reads: nothing
import { execFileSync } from 'node:child_process'

// Declares nothing and runs a script of the checkout with no cwd, so from the working directory.

export const ready = (): string =>
  execFileSync('node', ['scripts/canary-ready.ts'], { encoding: 'utf8' })
