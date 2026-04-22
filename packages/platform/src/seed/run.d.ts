import type { DocumentStoreAdapter, EventBusAdapter, Logger } from '@nymbal/types';
import type { NymbalConfig } from '@nymbal/config';
import type { CommandStore } from '../db/command-store.js';
export interface SeedDeps {
    config: NymbalConfig;
    commandStore: CommandStore;
    documentStore: DocumentStoreAdapter;
    eventBus: EventBusAdapter;
    logger: Logger;
    version: string;
}
export interface SeedResult {
    categories: number;
    products: number;
}
export declare function runSeed(deps: SeedDeps): Promise<SeedResult>;
//# sourceMappingURL=run.d.ts.map