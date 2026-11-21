import type { Metadata } from 'next'
import { renderNymbal } from '@/lib/render'
import { ResetPasswordView } from './ResetPasswordView'

export const metadata: Metadata = {
  title: 'Set a New Password',
}

export default function ResetPasswordPage() {
  return <ResetPasswordView serverHtml={renderNymbal('nymbal-reset-password-form').__html} />
}
