// Reads: nothing
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from '../../workspace-manifests'

// Declares nothing and reads compose.yaml from an imported root.

export const compose = (): string => readFileSync(join(REPO_ROOT, 'compose.yaml'), 'utf8')
