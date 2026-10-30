import { OrderNotFound } from './OrderNotFound'

// An order the store does not know, or one read without what opens it: the shopper can ask for a fresh link.
export default function OrderPageNotFound() {
  return <OrderNotFound />
}
