// Reads: nothing
import { readFileSync } from 'node:fs'

// Declares nothing and reads a workflow by a path relative to the working directory, which is the checkout's root.

export const workflow = (): string => readFileSync('.github/workflows/ci.yml', 'utf8')
