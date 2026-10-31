import { defineCommand } from 'citty'
import pc from 'picocolors'
import { slotFolder } from '@nymbalhq/config'
import { loadProject } from '../utils/project.js'
import { NymbalError } from '@nymbalhq/types'

export const configValidateCommand = defineCommand({
  meta: { name: 'config:validate', description: 'Validate nymbal.config.ts' },
  async run() {
    try {
      const { config, path } = await loadProject()
      // eslint-disable-next-line no-console
      console.log(pc.green(`✓ config valid`) + ` (${path})`)
      // eslint-disable-next-line no-console
      console.log(
        `  template: ${config.template}, command store: ${config.infrastructure.commandStore}, ${slotFolder('documentStore')}: ${config.infrastructure.documentStore.provider}, ${slotFolder('eventBus')}: ${config.infrastructure.eventBus.provider}`,
      )
      process.exit(0)
    } catch (err) {
      if (err instanceof NymbalError) {
        // eslint-disable-next-line no-console
        console.error(pc.red('✗ config invalid'))
        // eslint-disable-next-line no-console
        console.error(err.message)
      } else {
        // eslint-disable-next-line no-console
        console.error(err)
      }
      process.exit(1)
    }
  },
})
