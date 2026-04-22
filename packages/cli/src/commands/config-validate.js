import { defineCommand } from 'citty';
import pc from 'picocolors';
import { loadConfig } from '@nymbal/config';
import { NymbalError } from '@nymbal/types';
export const configValidateCommand = defineCommand({
    meta: { name: 'config:validate', description: 'Validate nymbal.config.ts' },
    async run() {
        try {
            const { config, path } = await loadConfig();
            // eslint-disable-next-line no-console
            console.log(pc.green(`✓ config valid`) + ` (${path})`);
            // eslint-disable-next-line no-console
            console.log(`  template: ${config.template}, cloud: ${config.infrastructure.cloud}, commandStore: ${config.infrastructure.commandStore}`);
            process.exit(0);
        }
        catch (err) {
            if (err instanceof NymbalError) {
                // eslint-disable-next-line no-console
                console.error(pc.red('✗ config invalid'));
                // eslint-disable-next-line no-console
                console.error(err.message);
            }
            else {
                // eslint-disable-next-line no-console
                console.error(err);
            }
            process.exit(1);
        }
    },
});
//# sourceMappingURL=config-validate.js.map