import { defineCommand } from 'citty';
import { loadConfig } from '@nymbal/config';
import { runOrFail } from '../utils/spawn.js';
export const buildCommand = defineCommand({
    meta: { name: 'build', description: 'Production build of the configured template' },
    async run() {
        const { config, projectRoot } = await loadConfig();
        const filter = config.template === 'astro' ? '@nymbal/template-astro' : '@nymbal/template-nextjs';
        await runOrFail('pnpm', ['--filter', filter, 'build'], { cwd: projectRoot });
    },
});
//# sourceMappingURL=build.js.map