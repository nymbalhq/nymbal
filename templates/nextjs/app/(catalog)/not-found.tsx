import { NotFoundView } from '@/components/server/NotFoundView'

// A catalog page with nothing to show (a product no longer sold), under the catalog's header. Next caches it with the
// page, so it reads no request.
export default function CatalogNotFound() {
  return <NotFoundView />
}
