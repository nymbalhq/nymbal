import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { NymbalConfig } from '@nymbal/config'

export type TemplateName = 'astro' | 'nextjs'

export interface TemplateLaunch {
  /** Working directory the storefront dev server runs in. */
  cwd: string
  /** Command + args to start the storefront dev server. */
  command: string
  args: string[]
  /**
   * How the storefront was located. `flat` = the project root IS the storefront
   * (create-nymbal-app output). `filter` = a sub-package in a monorepo layout.
   */
  mode: 'flat' | 'filter'
}

export function templateFilterFor(template: NymbalConfig['template']): string {
  return template === 'astro' ? '@nymbal/template-astro' : '@nymbal/template-nextjs'
}

/**
 * A flat scaffold (create-nymbal-app output) places the storefront AT the
 * project root: the framework config and a `dev` script live in projectRoot.
 * In that layout we must run the dev server in projectRoot directly — NOT via
 * `pnpm --filter @nymbal/template-astro`, which would match the workspace
 * template package (the wrong directory) inside a monorepo, or match nothing at
 * all outside one.
 */
export function isFlatScaffold(projectRoot: string, template: TemplateName): boolean {
  const marker = template === 'astro' ? 'astro.config.mjs' : 'next.config.mjs'
  const altMarker = template === 'astro' ? 'astro.config.ts' : 'next.config.ts'
  return existsSync(resolve(projectRoot, marker)) || existsSync(resolve(projectRoot, altMarker))
}

/**
 * Resolve the framework's local CLI bin inside the project's node_modules.
 * We spawn the local bin directly (rather than the package-manager `run dev`
 * script) so we can inject the resolved free port via `--port`, overriding the
 * hardcoded port baked into the scaffold's `dev` script. Returns null when the
 * bin is not present (deps not installed) so the caller can produce an
 * actionable error.
 */
export function resolveLocalBin(projectRoot: string, bin: string): string | null {
  const binPath = resolve(projectRoot, 'node_modules', '.bin', bin)
  return existsSync(binPath) ? binPath : null
}

/**
 * Build the storefront dev launch plan.
 *
 * @param storefrontPort - the resolved (free) port the storefront must bind to.
 *   Passed to the framework via flag so we control where it listens, instead of
 *   relying on the framework's hardcoded default which may already be taken.
 */
export function planTemplateLaunch(
  projectRoot: string,
  template: TemplateName,
  storefrontPort: number,
): TemplateLaunch {
  if (isFlatScaffold(projectRoot, template)) {
    // Run the framework dev server directly in the project root. We pass the
    // port explicitly so the framework binds where we resolved a free port,
    // overriding any hardcoded port in the scaffold's package.json script.
    const binName = template === 'astro' ? 'astro' : 'next'
    const localBin = resolveLocalBin(projectRoot, binName)
    if (!localBin) {
      throw new Error(
        `Cannot find the ${binName} dev server in ${projectRoot}/node_modules/.bin. ` +
          `Install dependencies first (e.g. \`pnpm install\`), then re-run \`nymbal dev\`.`,
      )
    }
    return {
      cwd: projectRoot,
      command: localBin,
      args: ['dev', '--port', String(storefrontPort)],
      mode: 'flat',
    }
  }

  // Monorepo layout fallback: the storefront lives in a workspace sub-package.
  const filter = templateFilterFor(template)
  return {
    cwd: projectRoot,
    command: 'pnpm',
    args: ['--filter', filter, 'dev'],
    mode: 'filter',
  }
}
