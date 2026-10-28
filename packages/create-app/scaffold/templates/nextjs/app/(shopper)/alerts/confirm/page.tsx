import type { Metadata } from 'next'
import { AlertLinkForm } from '../AlertLinkForm'
import { LinkInvalid } from '../LinkInvalid'

export const metadata: Metadata = { title: 'Email alert' }

interface ConfirmPageProps {
  searchParams: Promise<{ token?: string | string[] }>
}

// The link in a confirmation email: it shows the button and calls no API until the button is pressed.
export default async function ConfirmAlertPage({ searchParams }: ConfirmPageProps) {
  const { token } = await searchParams
  const value = typeof token === 'string' ? token : ''
  if (value === '') {
    return <LinkInvalid message="It may be from an older email, or the alert has been stopped." />
  }
  return <AlertLinkForm kind="confirm" token={value} />
}
