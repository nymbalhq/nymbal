import type { Metadata } from 'next'
import { renderNymbal } from '@/lib/render'
import { ForgotPasswordView } from './ForgotPasswordView'

export const metadata: Metadata = {
  title: 'Forgot Password',
}

export default function ForgotPasswordPage() {
  return <ForgotPasswordView serverHtml={renderNymbal('nymbal-forgot-password-form').__html} />
}
