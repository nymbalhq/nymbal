import type { Logger } from '@nymbal/types';
export interface CreateLoggerOptions {
    level?: string;
    pretty?: boolean;
    base?: Record<string, unknown>;
}
export declare function createLogger(options?: CreateLoggerOptions): Logger;
//# sourceMappingURL=logger.d.ts.map