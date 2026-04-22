import { defineCommand } from 'citty';
export const importCommand = defineCommand({
    meta: {
        name: 'import',
        description: 'Run a content import (placeholder — implementation lands in Prompt 6)',
    },
    args: {
        source: {
            type: 'string',
            description: 'Import source (woocommerce, shopify, csv)',
        },
    },
    async run() {
        // eslint-disable-next-line no-console
        console.log('nymbal import is not yet implemented. WooCommerce / Shopify / CSV importers arrive in a future release.');
    },
});
//# sourceMappingURL=import.js.map