import type { CommandStore } from '../command-store.js';
import type { CategoryRow } from '../schema/index.js';
export interface CategoryInsert {
    id: string;
    slug: string;
    name: string;
    description: string;
    createdAt: Date;
}
export declare function createCategoryRepository(store: CommandStore): {
    findAll(): Promise<CategoryRow[]>;
    insertMany(items: CategoryInsert[]): Promise<void>;
};
//# sourceMappingURL=categories.d.ts.map