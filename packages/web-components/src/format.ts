/** Minor units as the storefronts show money (`en-GB`, the templates' own formatting). */
export function formatPrice(minor: number, currency: string): string {
  return new Intl.NumberFormat('en-GB', { style: 'currency', currency }).format(minor / 100)
}
