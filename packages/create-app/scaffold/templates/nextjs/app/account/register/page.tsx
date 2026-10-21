import type { Metadata } from 'next'
import { RegisterView } from './RegisterView'

export const metadata: Metadata = {
  title: 'Create Account',
}

export default function RegisterPage() {
  return <RegisterView />
}
