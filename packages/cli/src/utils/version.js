import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
let cached = null;
export function getCliVersion() {
    if (cached)
        return cached;
    try {
        const here = dirname(fileURLToPath(import.meta.url));
        const pkg = JSON.parse(readFileSync(resolve(here, '../..', 'package.json'), 'utf8'));
        cached = pkg.version ?? '0.0.0';
    }
    catch {
        cached = '0.0.0';
    }
    return cached;
}
//# sourceMappingURL=version.js.map