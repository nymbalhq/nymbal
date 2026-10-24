import { PlainHeader } from '@/components/server/Header'
import { NotFoundView } from '@/components/server/NotFoundView'

// A URL no route matches, and a shopper page with nothing to show.
export default function NotFound() {
  return (
    <>
      <PlainHeader />
      <main id="main">
        <NotFoundView />
      </main>
    </>
  )
}
