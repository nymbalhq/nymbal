/**
 * tid('orders', 'row', orderId) -> 'admin-orders-row-<orderId>'
 * tid('orders', 'status-select') -> 'admin-orders-status-select'
 */
export function tid(...parts: string[]): string {
  return ['admin', ...parts].join('-')
}
