import * as sqliteSchema from '../schema/sqlite.js';
import * as postgresSchema from '../schema/postgres.js';
export function createCategoryRepository(store) {
    return {
        async findAll() {
            if (store.kind === 'sqlite') {
                const rows = store.db.select().from(sqliteSchema.categories).all();
                return rows;
            }
            const rows = await store.db.select().from(postgresSchema.categories);
            return rows;
        },
        async insertMany(items) {
            if (items.length === 0)
                return;
            if (store.kind === 'sqlite') {
                const rows = items.map((item) => ({
                    ...item,
                    createdAt: item.createdAt.toISOString(),
                }));
                store.db.insert(sqliteSchema.categories).values(rows).run();
                return;
            }
            await store.db.insert(postgresSchema.categories).values(items);
        },
    };
}
//# sourceMappingURL=categories.js.map