import type { NymbalEvent, NymbalEnvironment } from '@nymbal/types';
export interface EventBuilderContext {
    storeId: string;
    environment: NymbalEnvironment;
    version: string;
    source?: string;
}
export interface MakeEventOptions {
    source?: string;
    correlationId?: string;
    timestamp?: Date;
}
export declare function createEventBuilder(ctx: EventBuilderContext): <T>(type: string, payload: T, options?: MakeEventOptions) => NymbalEvent<T>;
//# sourceMappingURL=builder.d.ts.map