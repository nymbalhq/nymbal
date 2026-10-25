/** What a shopper asks to be told about a variant. Only `back_in_stock` is accepted for now. */
export type AlertKind = 'back_in_stock' | 'price_drop'

/**
 * `pending` until the confirmation's link is followed, then `active`; a back-in-stock row is `fired` once its alert is
 * sent; `unsubscribed` from any state by the link every email carries.
 */
export type AlertStatus = 'pending' | 'active' | 'fired' | 'unsubscribed'
