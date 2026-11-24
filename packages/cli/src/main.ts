import { defineCommand } from 'citty'
import { getCliVersion } from './utils/version.js'
import { buildCommand } from './commands/build.js'
import { deployCommand } from './commands/deploy.js'
import { configValidateCommand } from './commands/config-validate.js'
import { upgradeCommand } from './commands/upgrade.js'
import { updateCheckCommand } from './commands/update-check.js'

// A command whose module loads the platform, the importers, the HTTP server or the MCP SDK is imported when it runs:
// loading the platform is most of a start-up, and `--version`, `upgrade` or `deploy` never need it.
const security = () => import('./commands/security.js')
const test = () => import('./commands/test.js')

/** The command tree every `nymbal` invocation runs, and what the CLI reference is generated from. */
export const main = defineCommand({
  meta: {
    name: 'nymbal',
    version: getCliVersion(),
    description: 'Nymbal developer CLI',
  },
  subCommands: {
    dev: () => import('./commands/dev.js').then((m) => m.devCommand),
    build: buildCommand,
    start: () => import('./commands/start.js').then((m) => m.startCommand),
    deploy: deployCommand,
    migrate: () => import('./commands/migrate.js').then((m) => m.migrateCommand),
    seed: () => import('./commands/seed.js').then((m) => m.seedCommand),
    import: () => import('./commands/import.js').then((m) => m.importCommand),
    preview: () => import('./commands/preview.js').then((m) => m.previewCommand),
    'config:validate': configValidateCommand,
    add: () => import('./commands/add.js').then((m) => m.addCommand),
    upgrade: upgradeCommand,
    verify: () => import('./commands/verify.js').then((m) => m.verifyCommand),
    'update-check': updateCheckCommand,
    doctor: () => import('./commands/doctor.js').then((m) => m.doctorCommand),
    heartbeat: () => import('./commands/heartbeat.js').then((m) => m.heartbeatCommand),
    'security:plan': () => security().then((m) => m.securityPlanCommand),
    'security:apply': () => security().then((m) => m.securityApplyCommand),
    'security:drift': () => security().then((m) => m.securityDriftCommand),
    'security:inspect': () => security().then((m) => m.securityInspectCommand),
    secrets: () => import('./commands/secrets.js').then((m) => m.secretsCommand),
    events: () => import('./commands/events.js').then((m) => m.eventsCommand),
    suppressions: () => import('./commands/suppressions.js').then((m) => m.suppressionsCommand),
    audit: () => import('./commands/audit.js').then((m) => m.auditCommand),
    replay: () => import('./commands/replay.js').then((m) => m.replayCommand),
    mcp: () => import('./commands/mcp.js').then((m) => m.mcpCommand),
    eval: () => import('./commands/eval.js').then((m) => m.evalCommand),
    test: () => test().then((m) => m.testCommand),
    'test:e2e': () => test().then((m) => m.testE2eCommand),
    'test:visual': () => test().then((m) => m.testVisualCommand),
    'test:contracts': () => test().then((m) => m.testContractsCommand),
    'test:performance': () => test().then((m) => m.testPerformanceCommand),
    'test:all': () => test().then((m) => m.testAllCommand),
  },
})
