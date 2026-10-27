import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from '../../workspace-manifests'

// No declaration line, and a read of the root manifest.

export const manifest = (): string => readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')
