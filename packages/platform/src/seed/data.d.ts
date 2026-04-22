export interface SeedCategory {
    slug: string;
    name: string;
    description: string;
}
export interface SeedProduct {
    slug: string;
    title: string;
    description: string;
    priceMinor: number;
    categorySlug: string;
    imageUrl: string;
}
export declare const seedCategories: SeedCategory[];
export declare const seedProducts: SeedProduct[];
//# sourceMappingURL=data.d.ts.map