import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';
export const categories = sqliteTable('categories', {
    id: text('id').primaryKey(),
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    createdAt: text('created_at').notNull(),
});
export const products = sqliteTable('products', {
    id: text('id').primaryKey(),
    slug: text('slug').notNull().unique(),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    priceMinor: integer('price_minor').notNull(),
    currency: text('currency').notNull(),
    categoryId: text('category_id').notNull(),
    imageUrl: text('image_url').notNull().default(''),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
});
export const schema = { categories, products };
//# sourceMappingURL=sqlite.js.map