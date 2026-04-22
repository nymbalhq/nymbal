import type { DocumentStoreAdapter, RouteHandler } from '@nymbal/types';
export interface ProductListItem {
    id: string;
    slug: string;
    title: string;
    description: string;
    priceMinor: number;
    currency: string;
    categoryId: string;
    imageUrl: string;
}
export declare function createProductsRoute(documentStore: DocumentStoreAdapter, storeId: string): RouteHandler;
//# sourceMappingURL=products.d.ts.map