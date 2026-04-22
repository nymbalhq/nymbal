import { v7 as uuidv7 } from 'uuid';
import { ValidationError } from '@nymbal/types';
export class InProcessEventBus {
    #registrations = new Map();
    #logger;
    constructor(options = {}) {
        this.#logger = options.logger;
    }
    async publish(event) {
        this.#validate(event);
        const matches = Array.from(this.#registrations.values()).filter((r) => r.regexes.some((re) => re.test(event.type)));
        await Promise.all(matches.map(async (r) => {
            try {
                await r.handler(event);
            }
            catch (err) {
                this.#logger?.error({ err, subscriptionId: r.id, eventType: event.type, eventId: event.id }, 'Event handler failed');
            }
        }));
    }
    async publishBatch(events) {
        for (const event of events) {
            await this.publish(event);
        }
    }
    async subscribe(eventPattern, handler, config) {
        const patterns = Array.isArray(eventPattern) ? eventPattern : [eventPattern];
        const regexes = patterns.map(compilePattern);
        const id = uuidv7();
        const registration = { id, patterns, regexes, handler, config };
        this.#registrations.set(id, registration);
        const self = this;
        return {
            id,
            patterns,
            async unsubscribe() {
                self.#registrations.delete(id);
            },
        };
    }
    async unsubscribe(subscription) {
        this.#registrations.delete(subscription.id);
    }
    async close() {
        this.#registrations.clear();
    }
    #validate(event) {
        if (!event.id || !event.type || !event.timestamp || !event.source) {
            throw new ValidationError('Event is missing required envelope fields', {
                context: { event },
            });
        }
        if (!event.metadata || !event.metadata.storeId || !event.metadata.environment) {
            throw new ValidationError('Event metadata is missing required fields', {
                context: { event },
            });
        }
    }
}
function compilePattern(pattern) {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\*]/g, '\\$&').replace(/\\\*/g, '.*');
    return new RegExp(`^${escaped}$`);
}
//# sourceMappingURL=in-process.js.map