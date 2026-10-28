// Reads: packages/platform/src/services/*.ts, scripts/gate.ts
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { REPO_ROOT } from '../../workspace-manifests'

// Judged as a tooling test: it declares kernel source beside a script.

export const sources = (): string[] =>
  ['packages/platform/src/services/cart-service.ts', 'scripts/gate.ts'].map((f) =>
    readFileSync(join(REPO_ROOT, f), 'utf8'),
  )
