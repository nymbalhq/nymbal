import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineCommand } from 'citty'
import { loadProject } from '../utils/project.js'
import { runOrFail } from '../utils/spawn.js'
import { isFlatScaffold, resolveLocalBin, templateFilterFor } from '../utils/template-runner.js'
import { DOCKERIGNORE, renderDockerfile } from '../deploy/dockerfile.js'

export const buildCommand = defineCommand({
  meta: { name: 'build', description: 'Production build of the configured template' },
  args: {
    image: {
      type: 'boolean',
      description: 'Build a container image of the store (writes a Dockerfile when absent)',
      default: false,
    },
    tag: {
      type: 'string',
      description: 'The image name (default: <package name>:latest)',
    },
  },
  async run({ args }) {
    const { config, projectRoot } = await loadProject()
    if (args.image) {
      await buildImage(projectRoot, config.template, args.tag, args._)
      return
    }
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

/** Writes the Dockerfile and .dockerignore when absent, then `docker build`; arguments after `--` go to docker. */
async function buildImage(
  root: string,
  template: 'astro' | 'nextjs',
  tag: string | undefined,
  dockerArgs: string[],
): Promise<void> {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
    name?: string
    packageManager?: string
  }
  const dockerfile = join(root, 'Dockerfile')
  if (existsSync(dockerfile)) {
    // eslint-disable-next-line no-console
    console.log('Using the Dockerfile already in the project, as it is')
  } else {
    if (pkg.packageManager === undefined) {
      throw new Error(
        'package.json records no "packageManager" (such as "pnpm@10.18.0"), so the image cannot install as the project does',
      )
    }
    const nodeVersionFile = join(root, '.node-version')
    const nodeVersion = existsSync(nodeVersionFile)
      ? readFileSync(nodeVersionFile, 'utf8').trim().replace(/^v/, '')
      : process.versions.node
    writeFileSync(
      dockerfile,
      renderDockerfile({ packageManager: pkg.packageManager, nodeVersion, template }),
    )
    // eslint-disable-next-line no-console
    console.log('✓ wrote Dockerfile')
  }
  const ignore = join(root, '.dockerignore')
  if (!existsSync(ignore)) {
    writeFileSync(ignore, DOCKERIGNORE)
    // eslint-disable-next-line no-console
    console.log('✓ wrote .dockerignore')
  }
  const name = tag ?? `${(pkg.name ?? 'store').replace(/^@/, '').replace(/\//g, '-')}:latest`
  await runOrFail('docker', ['build', '-t', name, ...dockerArgs, '.'], { cwd: root })
}
