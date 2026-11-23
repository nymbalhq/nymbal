'use client'

import { useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { SessionList } from '@nymbalhq/react'

/** `serverHtml` is the list as the server rendered it (page.tsx). */
export function SessionsView({ serverHtml }: { serverHtml: string }) {
  const router = useRouter()
  // This browser's session ended: as the layout's sign-out does, go to the sign-in page.
  const onSignedOut = useCallback(() => router.push('/account/login'), [router])

  return <SessionList onSignedOut={onSignedOut} serverHtml={serverHtml} />
}
