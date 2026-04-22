export interface CommerceAdapter {
    readonly providerName: string;
}
export interface PaymentsAdapter extends CommerceAdapter {
    readonly kind: 'payments';
}
export interface EmailAdapter extends CommerceAdapter {
    readonly kind: 'email';
}
export interface ReviewsAdapter extends CommerceAdapter {
    readonly kind: 'reviews';
}
export interface SearchAdapter extends CommerceAdapter {
    readonly kind: 'search';
}
export interface AnalyticsAdapter extends CommerceAdapter {
    readonly kind: 'analytics';
}
export interface ShippingAdapter extends CommerceAdapter {
    readonly kind: 'shipping';
}
export interface TaxAdapter extends CommerceAdapter {
    readonly kind: 'tax';
}
export interface AiAdapter extends CommerceAdapter {
    readonly kind: 'ai';
}
//# sourceMappingURL=commerce.d.ts.map