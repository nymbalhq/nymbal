/** What a shopper asks to be told about a variant: that it is back in stock, or that its price dropped. */
export type AlertKind = 'back_in_stock' | 'price_drop'

/**
 * `pending` until the confirmation's link is followed, then `active`; a back-in-stock row is `fired` once its alert is
 * sent, a price-drop row stays `active`; `unsubscribed` from any state by the link every email carries.
 */
export type AlertStatus = 'pending' | 'active' | 'fired' | 'unsubscribed'
