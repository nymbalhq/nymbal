import { defineCommand } from 'citty'
import { getCliVersion } from './utils/version.js'
import { devCommand } from './commands/dev.js'
import { buildCommand } from './commands/build.js'
import { startCommand } from './commands/start.js'
import { deployCommand } from './commands/deploy.js'
import { migrateCommand } from './commands/migrate.js'
import { seedCommand } from './commands/seed.js'
import { importCommand } from './commands/import.js'
import { previewCommand } from './commands/preview.js'
import { configValidateCommand } from './commands/config-validate.js'
import { addCommand } from './commands/add.js'
import { doctorCommand } from './commands/doctor.js'
import { secretsCommand } from './commands/secrets.js'
import { eventsCommand } from './commands/events.js'
import { suppressionsCommand } from './commands/suppressions.js'
import { auditCommand } from './commands/audit.js'
import { replayCommand } from './commands/replay.js'
import { mcpCommand } from './commands/mcp.js'
import { evalCommand } from './commands/eval.js'
import { upgradeCommand } from './commands/upgrade.js'
import {
  securityApplyCommand,
  securityDriftCommand,
  securityInspectCommand,
  securityPlanCommand,
} from './commands/security.js'
import {
  testAllCommand,
  testCommand,
  testContractsCommand,
  testE2eCommand,
  testPerformanceCommand,
  testVisualCommand,
} from './commands/test.js'

/** The command tree every `nymbal` invocation runs, and what the CLI reference is generated from. */
export const main = defineCommand({
  meta: {
    name: 'nymbal',
    version: getCliVersion(),
    description: 'Nymbal developer CLI',
  },
  subCommands: {
    dev: devCommand,
    build: buildCommand,
    start: startCommand,
    deploy: deployCommand,
    migrate: migrateCommand,
    seed: seedCommand,
    import: importCommand,
    preview: previewCommand,
    'config:validate': configValidateCommand,
    add: addCommand,
    upgrade: upgradeCommand,
    doctor: doctorCommand,
    'security:plan': securityPlanCommand,
    'security:apply': securityApplyCommand,
    'security:drift': securityDriftCommand,
    'security:inspect': securityInspectCommand,
    secrets: secretsCommand,
    events: eventsCommand,
    suppressions: suppressionsCommand,
    audit: auditCommand,
    replay: replayCommand,
    mcp: mcpCommand,
    eval: evalCommand,
    test: testCommand,
    'test:e2e': testE2eCommand,
    'test:visual': testVisualCommand,
    'test:contracts': testContractsCommand,
    'test:performance': testPerformanceCommand,
    'test:all': testAllCommand,
  },
})
