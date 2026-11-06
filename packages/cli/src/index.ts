import { runMain, showUsage } from 'citty'
import { getCliVersion } from './utils/version.js'
import { addCommand, addUsage } from './commands/add.js'
import { main } from './main.js'

export { resolveAdminRoot } from './admin.js'

// citty prints --version through consola, which prefixes `[log]` when CI is set; scripts need the bare version.
const [flag, ...rest] = process.argv.slice(2)
if (rest.length === 0 && (flag === '--version' || flag === '-v')) {
  process.stdout.write(`${getCliVersion()}\n`)
} else {
  runMain(main, {
    // `nymbal add --help` lists the forms, the slots with their providers, and the recipes.
    showUsage: async (cmd, parent) => {
      await showUsage(cmd, parent)
      if ((cmd as unknown) === addCommand) process.stdout.write(`${addUsage()}\n`)
    },
  })
}
