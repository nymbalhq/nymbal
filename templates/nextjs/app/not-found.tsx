import { PlainHeader } from '@/components/server/Header'
import { NotFoundView } from '@/components/server/NotFoundView'

// A URL no route matches.
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
