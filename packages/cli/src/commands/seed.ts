import { defineCommand } from 'citty'
import { loadProject } from '../utils/project.js'
import { createPlatform, resolvePrimitives, runSeed } from '@nymbalhq/platform'
import { getCliVersion } from '../utils/version.js'
import { migrateProject } from './migrate.js'

export const seedCommand = defineCommand({
  meta: { name: 'seed', description: 'Re-seed demo content (products, categories)' },
  args: {
    localImages: {
      type: 'boolean',
      // citty registers the camelCase key only; the alias maps the kebab flag onto it (see `dev --api-only`).
      alias: 'local-images',
      description:
        "Write the product images through the store's media slot instead of linking a placeholder host",
      default: false,
    },
    mediaRoot: {
      type: 'string',
      alias: 'media-root',
      description: 'Where local-fs media is written (default: public/imported-media)',
    },
  },
  async run({ args }) {
    const { config, projectRoot } = await loadProject()
    // A fresh project has no tables yet; `nymbal dev` migrates before it seeds, and so does this.
    await migrateProject(config, projectRoot)
    const mediaRoot =
      typeof args.mediaRoot === 'string' && args.mediaRoot !== '' ? args.mediaRoot : undefined
    const platform = createPlatform(
      config,
      await resolvePrimitives(config, mediaRoot === undefined ? {} : { mediaRoot }),
    )
    try {
      const result = await runSeed({
        config,
        commandStore: platform.commandStore,
        documentStore: platform.documentStore,
        eventBus: platform.eventBus,
        logger: platform.logger,
        version: getCliVersion(),
        ...(args.localImages && { media: platform.media }),
      })
      // eslint-disable-next-line no-console
      console.log(
        result.alreadySeeded
          ? '✓ demo content already present, nothing to seed'
          : `✓ seeded ${result.products} products across ${result.categories} categories`,
      )
    } finally {
      await platform.close()
    }
  },
})
