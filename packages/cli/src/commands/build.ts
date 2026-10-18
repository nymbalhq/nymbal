import { defineCommand } from 'citty'
import { loadProject } from '../utils/project.js'
import { runOrFail } from '../utils/spawn.js'
import { isFlatScaffold, resolveLocalBin, templateFilterFor } from '../utils/template-runner.js'

export const buildCommand = defineCommand({
  meta: { name: 'build', description: 'Production build of the configured template' },
  async run() {
    const { config, projectRoot } = await loadProject()
    if (!isFlatScaffold(projectRoot, config.template)) {
      // Inside this monorepo the storefront is a workspace package.
      await runOrFail('pnpm', ['--filter', templateFilterFor(config.template), 'build'], {
        cwd: projectRoot,
      })
      return
    }
    const binName = config.template === 'astro' ? 'astro' : 'next'
    const bin = resolveLocalBin(projectRoot, binName)
    if (!bin) {
      throw new Error(
        `Cannot find the ${binName} binary in ${projectRoot}/node_modules/.bin. ` +
          'Install dependencies first, then re-run `nymbal build`.',
      )
    }
    await runOrFail(bin, ['build'], { cwd: projectRoot })
  },
})
