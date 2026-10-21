import { defineCommand, runMain } from 'citty'
import { getCliVersion } from './utils/version.js'
import { devCommand } from './commands/dev.js'
import { buildCommand } from './commands/build.js'
import { migrateCommand } from './commands/migrate.js'
import { seedCommand } from './commands/seed.js'
import { importCommand } from './commands/import.js'
import { configValidateCommand } from './commands/config-validate.js'
import { addCommand } from './commands/add.js'
import { doctorCommand } from './commands/doctor.js'
import {
  testAllCommand,
  testCommand,
  testContractsCommand,
  testE2eCommand,
  testPerformanceCommand,
  testVisualCommand,
} from './commands/test.js'

export { resolveAdminRoot } from './admin.js'

const main = defineCommand({
  meta: {
    name: 'nymbal',
    version: getCliVersion(),
    description: 'Nymbal developer CLI',
  },
  subCommands: {
    dev: devCommand,
    build: buildCommand,
    migrate: migrateCommand,
    seed: seedCommand,
    import: importCommand,
    'config:validate': configValidateCommand,
    add: addCommand,
    doctor: doctorCommand,
    test: testCommand,
    'test:e2e': testE2eCommand,
    'test:visual': testVisualCommand,
    'test:contracts': testContractsCommand,
    'test:performance': testPerformanceCommand,
    'test:all': testAllCommand,
  },
})

// citty prints --version through consola, which prefixes `[log]` when CI is set; scripts need the bare version.
const [flag, ...rest] = process.argv.slice(2)
if (rest.length === 0 && (flag === '--version' || flag === '-v')) {
  process.stdout.write(`${getCliVersion()}\n`)
} else {
  runMain(main)
}
