// Reads: compose.yaml
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from '../../workspace-manifests'

// Declares the one checkout file it reads.

export const compose = (): string => readFileSync(join(REPO_ROOT, 'compose.yaml'), 'utf8')
