import { describe, expect, it } from 'vitest';
import { InMemoryDocumentStore } from '@nymbal/platform';
// Contract suite — any DocumentStoreAdapter must pass this. Today only in-memory exists;
// production backends (dynamodb, firestore, cosmosdb, postgres-jsonb) will plug in here.
const adapters = [
    { name: 'in-memory', build: () => new InMemoryDocumentStore({ sweepIntervalMs: 0 }) },
];
for (const { name, build } of adapters) {
    describe(`DocumentStoreAdapter contract — ${name}`, () => {
        it('get returns null for missing key', async () => {
            const store = build();
            expect(await store.get('c', 'nope')).toBeNull();
            await store.close();
        });
        it('put then get round-trips', async () => {
            const store = build();
            await store.put('c', 'k', { v: 42 });
            expect(await store.get('c', 'k')).toEqual({ v: 42 });
            await store.close();
        });
        it('delete removes document', async () => {
            const store = build();
            await store.put('c', 'k', { v: 1 });
            await store.delete('c', 'k');
            expect(await store.get('c', 'k')).toBeNull();
            await store.close();
        });
    });
}
//# sourceMappingURL=document-store.test.js.map