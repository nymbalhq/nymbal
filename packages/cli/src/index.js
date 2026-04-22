import { defineCommand, runMain } from 'citty';
import { getCliVersion } from './utils/version.js';
import { devCommand } from './commands/dev.js';
import { buildCommand } from './commands/build.js';
import { migrateCommand } from './commands/migrate.js';
import { seedCommand } from './commands/seed.js';
import { importCommand } from './commands/import.js';
import { configValidateCommand } from './commands/config-validate.js';
import { testAllCommand, testCommand, testContractsCommand, testE2eCommand, testPerformanceCommand, testVisualCommand, } from './commands/test.js';
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
        test: testCommand,
        'test:e2e': testE2eCommand,
        'test:visual': testVisualCommand,
        'test:contracts': testContractsCommand,
        'test:performance': testPerformanceCommand,
        'test:all': testAllCommand,
    },
});
runMain(main);
//# sourceMappingURL=index.js.map