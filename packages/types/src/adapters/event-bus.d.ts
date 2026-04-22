export type NymbalEnvironment = 'production' | 'staging' | 'development';
export interface EventMetadata {
    storeId: string;
    environment: NymbalEnvironment;
    version: string;
}
export interface NymbalEvent<T = unknown> {
    id: string;
    type: string;
    timestamp: string;
    source: string;
    correlationId: string;
    payload: T;
    metadata: EventMetadata;
}
export type EventHandler<T = unknown> = (event: NymbalEvent<T>) => Promise<void> | void;
export interface RetryPolicy {
    maxAttempts: number;
    backoff: 'exponential' | 'linear' | 'fixed';
    initialDelayMs?: number;
}
export interface SubscriptionConfig {
    retryPolicy?: RetryPolicy;
    deadLetterQueue?: string;
    batchSize?: number;
    name?: string;
}
export interface Subscription {
    id: string;
    patterns: string[];
    unsubscribe(): Promise<void>;
}
export interface EventBusAdapter {
    publish<T>(event: NymbalEvent<T>): Promise<void>;
    publishBatch(events: NymbalEvent<unknown>[]): Promise<void>;
    subscribe(eventPattern: string | string[], handler: EventHandler, config?: SubscriptionConfig): Promise<Subscription>;
    unsubscribe(subscription: Subscription): Promise<void>;
    close(): Promise<void>;
}
//# sourceMappingURL=event-bus.d.ts.map