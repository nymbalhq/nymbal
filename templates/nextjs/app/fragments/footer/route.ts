import { FOOTER_COLUMNS } from '@/lib/chrome'
import { fragment } from '@/lib/fragments'
import { renderElement } from '@/lib/render'

export const revalidate = 86400

export function GET(): Response {
  return fragment(
    renderElement('nymbal-site-footer', {
      attributes: { columns: JSON.stringify(FOOTER_COLUMNS) },
    }),
  )
}
