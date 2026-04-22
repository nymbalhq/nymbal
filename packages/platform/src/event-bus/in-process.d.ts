import type { EventBusAdapter, EventHandler, NymbalEvent, Subscription, SubscriptionConfig, Logger } from '@nymbal/types';
export interface InProcessEventBusOptions {
    logger?: Logger;
}
export declare class InProcessEventBus implements EventBusAdapter {
    #private;
    constructor(options?: InProcessEventBusOptions);
    publish<T>(event: NymbalEvent<T>): Promise<void>;
    publishBatch(events: NymbalEvent<unknown>[]): Promise<void>;
    subscribe(eventPattern: string | string[], handler: EventHandler, config?: SubscriptionConfig): Promise<Subscription>;
    unsubscribe(subscription: Subscription): Promise<void>;
    close(): Promise<void>;
}
//# sourceMappingURL=in-process.d.ts.map