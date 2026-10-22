import type { Metadata } from 'next'
import { Suspense } from 'react'
import { renderNymbal } from '@/lib/render'
import { LoginView } from './LoginView'

export const metadata: Metadata = {
  title: 'Sign In',
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="loading-center">
          <div className="spinner spinner-lg" role="status">
            <span className="visually-hidden">Loading...</span>
          </div>
        </div>
      }
    >
      <LoginView serverHtml={renderNymbal('nymbal-login-form').__html} />
    </Suspense>
  )
}
