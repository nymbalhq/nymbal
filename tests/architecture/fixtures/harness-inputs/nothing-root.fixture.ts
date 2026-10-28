// Reads: nothing
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Declares nothing and lists the checkout from a root with no trailing slash.

const ROOT = fileURLToPath(new URL('../..', import.meta.url))

export const listed = (): string =>
  execFileSync('git', ['ls-files', '--', 'templates'], { cwd: ROOT, encoding: 'utf8' })
