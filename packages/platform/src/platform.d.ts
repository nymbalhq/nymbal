import type { NymbalConfig } from '@nymbal/config';
import type { DocumentStoreAdapter, EventBusAdapter, Logger } from '@nymbal/types';
import { type CommandStore } from './db/command-store.js';
export interface Platform {
    config: NymbalConfig;
    commandStore: CommandStore;
    documentStore: DocumentStoreAdapter;
    eventBus: EventBusAdapter;
    logger: Logger;
    close(): Promise<void>;
}
export interface CreatePlatformOptions {
    logger?: Logger;
    sqlitePath?: string;
    postgresUrl?: string;
}
export declare function createPlatform(config: NymbalConfig, options?: CreatePlatformOptions): Platform;
//# sourceMappingURL=platform.d.ts.map