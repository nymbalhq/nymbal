// Reads: .github/workflows/no-such-workflow.yml
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from '../../workspace-manifests'

// Declares a workflow the checkout does not hold, as a rename leaves behind.

export const workflow = (): string =>
  readFileSync(join(REPO_ROOT, '.github/workflows/no-such-workflow.yml'), 'utf8')
