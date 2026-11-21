import type { Metadata } from 'next'
import { renderNymbal } from '@/lib/render'
import { VerifyEmailView } from './VerifyEmailView'

export const metadata: Metadata = {
  title: 'Confirm Your Email',
}

export default function VerifyEmailPage() {
  return <VerifyEmailView serverHtml={renderNymbal('nymbal-verify-email').__html} />
}
