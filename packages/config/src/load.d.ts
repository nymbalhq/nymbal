import { type NymbalConfig } from './schema.js';
export interface LoadedConfig {
    config: NymbalConfig;
    path: string;
    projectRoot: string;
}
export declare function findConfigFile(startDir: string): string | null;
export declare function loadConfig(startDir?: string): Promise<LoadedConfig>;
//# sourceMappingURL=load.d.ts.map