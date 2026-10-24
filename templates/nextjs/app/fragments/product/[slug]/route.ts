import { fetchProduct } from '@/lib/api'
import { fragment, noFragment } from '@/lib/fragments'
import { cardProductOf, renderElement } from '@/lib/render'

export const revalidate = 300
// The build prerenders no product, since the API may be down then.
export function generateStaticParams(): Array<{ slug: string }> {
  return []
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const product = await fetchProduct((await params).slug)
  if (product === null) return noFragment()
  return fragment(
    renderElement('nymbal-product-card', {
      attributes: { product: JSON.stringify(cardProductOf(product)) },
    }),
  )
}
