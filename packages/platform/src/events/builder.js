import { v7 as uuidv7 } from 'uuid';
export function createEventBuilder(ctx) {
    return function makeEvent(type, payload, options = {}) {
        const id = uuidv7();
        return {
            id,
            type,
            timestamp: (options.timestamp ?? new Date()).toISOString(),
            source: options.source ?? ctx.source ?? 'nymbal-platform',
            correlationId: options.correlationId ?? id,
            payload,
            metadata: {
                storeId: ctx.storeId,
                environment: ctx.environment,
                version: ctx.version,
            },
        };
    };
}
//# sourceMappingURL=builder.js.map