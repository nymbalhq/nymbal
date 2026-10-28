// Reads: **/ci.yml
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from '../../workspace-manifests'

// Declares the workflow it reads by a glob that matches it only through a dot-directory.

export const workflow = (): string =>
  readFileSync(join(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8')
