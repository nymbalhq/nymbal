'use client'

import { useCallback } from 'react'
import { MiniCart } from '@nymbalhq/react'

/** The header's mini-cart: `count` and `serverHtml` are the server's render of it (components/server/Header.tsx). */
export function MiniCartWrapper({ count, serverHtml }: { count?: number; serverHtml?: string }) {
  const handleClick = useCallback(() => {
    window.dispatchEvent(new CustomEvent('nymbal:cart:open'))
  }, [])

  return <MiniCart onClick={handleClick} count={count} serverHtml={serverHtml} />
}
