import { fetchCategories } from '@/lib/api'
import { fragment, noFragment } from '@/lib/fragments'
import { renderElement } from '@/lib/render'

export const revalidate = 21600
// A dynamic segment, so the build prerenders nothing when the API may be down; next.config.mjs rewrites
// `/fragments/<name>` to `/fragments/<name>/index`.
export function generateStaticParams(): Array<{ key: string }> {
  return []
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ key: string }> },
): Promise<Response> {
  if ((await params).key !== 'index') return noFragment()
  const categories = await fetchCategories()
  return fragment(
    renderElement('nymbal-category-nav', {
      attributes: { categories: JSON.stringify(categories) },
    }),
  )
}
