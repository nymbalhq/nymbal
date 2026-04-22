import type { CommandStore } from '../command-store.js';
import type { ProductRow } from '../schema/index.js';
export interface ProductInsert {
    id: string;
    slug: string;
    title: string;
    description: string;
    priceMinor: number;
    currency: string;
    categoryId: string;
    imageUrl: string;
    createdAt: Date;
    updatedAt: Date;
}
export declare function createProductRepository(store: CommandStore): {
    findAll(): Promise<ProductRow[]>;
    findBySlug(slug: string): Promise<ProductRow | null>;
    insertMany(items: ProductInsert[]): Promise<void>;
};
//# sourceMappingURL=products.d.ts.map