import type { Metadata } from 'next'
import { renderNymbal } from '@/lib/render'
import { RegisterView } from './RegisterView'

export const metadata: Metadata = {
  title: 'Create Account',
}

export default function RegisterPage() {
  return <RegisterView serverHtml={renderNymbal('nymbal-register-form').__html} />
}
