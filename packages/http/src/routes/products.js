export function createProductsRoute(documentStore, storeId) {
    return async (ctx) => {
        const rawLimit = ctx.query.limit;
        const limitValue = Array.isArray(rawLimit) ? rawLimit[0] : rawLimit;
        const limit = limitValue ? Math.min(100, Math.max(1, Number(limitValue) || 20)) : 50;
        const rawCursor = ctx.query.cursor;
        const cursorValue = Array.isArray(rawCursor) ? rawCursor[0] : rawCursor;
        const result = await documentStore.query('products', {
            partitionKey: { field: 'storeId', value: storeId },
            limit,
            ...(cursorValue !== undefined && { cursor: cursorValue }),
            ascending: true,
        });
        return {
            status: 200,
            body: { items: result.items, nextCursor: result.nextCursor },
        };
    };
}
//# sourceMappingURL=products.js.map