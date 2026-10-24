import { fragment, noFragment } from '@/lib/fragments'
import { canSearch, siteHeader } from '@/lib/header'
import { renderElement } from '@/lib/render'

export const revalidate = 3600
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
  return fragment(renderElement('nymbal-site-header', siteHeader(await canSearch())))
}
