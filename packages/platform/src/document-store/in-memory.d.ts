import type { DocumentStoreAdapter, PutOptions, QueryParams, QueryResult } from '@nymbal/types';
export interface InMemoryDocumentStoreOptions {
    sweepIntervalMs?: number;
    now?: () => number;
}
export declare class InMemoryDocumentStore implements DocumentStoreAdapter {
    #private;
    constructor(options?: InMemoryDocumentStoreOptions);
    get<T>(collection: string, key: string): Promise<T | null>;
    put<T>(collection: string, key: string, document: T, options?: PutOptions): Promise<void>;
    delete(collection: string, key: string): Promise<void>;
    query<T>(collection: string, params: QueryParams): Promise<QueryResult<T>>;
    batchGet<T>(collection: string, keys: string[]): Promise<Map<string, T>>;
    batchPut<T>(collection: string, items: Map<string, T>): Promise<void>;
    close(): Promise<void>;
}
//# sourceMappingURL=in-memory.d.ts.map