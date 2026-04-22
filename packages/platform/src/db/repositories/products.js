import * as sqliteSchema from '../schema/sqlite.js';
import * as postgresSchema from '../schema/postgres.js';
import { eq } from 'drizzle-orm';
export function createProductRepository(store) {
    return {
        async findAll() {
            if (store.kind === 'sqlite') {
                const rows = store.db.select().from(sqliteSchema.products).all();
                return rows;
            }
            const rows = await store.db.select().from(postgresSchema.products);
            return rows;
        },
        async findBySlug(slug) {
            if (store.kind === 'sqlite') {
                const row = store.db
                    .select()
                    .from(sqliteSchema.products)
                    .where(eq(sqliteSchema.products.slug, slug))
                    .get();
                return row ?? null;
            }
            const [row] = await store.db
                .select()
                .from(postgresSchema.products)
                .where(eq(postgresSchema.products.slug, slug));
            return row ?? null;
        },
        async insertMany(items) {
            if (items.length === 0)
                return;
            if (store.kind === 'sqlite') {
                const rows = items.map((item) => ({
                    ...item,
                    createdAt: item.createdAt.toISOString(),
                    updatedAt: item.updatedAt.toISOString(),
                }));
                store.db.insert(sqliteSchema.products).values(rows).run();
                return;
            }
            await store.db.insert(postgresSchema.products).values(items);
        },
    };
}
//# sourceMappingURL=products.js.map