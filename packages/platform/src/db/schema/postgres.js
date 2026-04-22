import { pgTable, text, integer, timestamp } from 'drizzle-orm/pg-core';
export const categories = pgTable('categories', {
    id: text('id').primaryKey(),
    slug: text('slug').notNull().unique(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});
export const products = pgTable('products', {
    id: text('id').primaryKey(),
    slug: text('slug').notNull().unique(),
    title: text('title').notNull(),
    description: text('description').notNull().default(''),
    priceMinor: integer('price_minor').notNull(),
    currency: text('currency').notNull(),
    categoryId: text('category_id').notNull(),
    imageUrl: text('image_url').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
});
export const schema = { categories, products };
//# sourceMappingURL=postgres.js.map