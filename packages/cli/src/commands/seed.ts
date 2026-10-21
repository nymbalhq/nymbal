import { defineCommand } from 'citty'
import { loadProject } from '../utils/project.js'
import { createPlatform, resolvePrimitives, runSeed } from '@nymbalhq/platform'
import { getCliVersion } from '../utils/version.js'
import { migrateProject } from './migrate.js'

export const seedCommand = defineCommand({
  meta: { name: 'seed', description: 'Re-seed demo content (products, categories)' },
  async run() {
    const { config, projectRoot } = await loadProject()
    // A fresh project has no tables yet; `nymbal dev` migrates before it seeds, and so does this.
    await migrateProject(config, projectRoot)
    const platform = createPlatform(config, await resolvePrimitives(config))
    try {
      const result = await runSeed({
        config,
        commandStore: platform.commandStore,
        documentStore: platform.documentStore,
        eventBus: platform.eventBus,
        logger: platform.logger,
        version: getCliVersion(),
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
