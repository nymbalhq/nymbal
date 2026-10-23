import type { Metadata } from 'next'
import { renderNymbal } from '@/lib/render'
import { LoginView } from './LoginView'

export const metadata: Metadata = {
  title: 'Sign In',
}

interface LoginPageProps {
  searchParams: Promise<{ redirect?: string | string[] }>
}

// The page reads `redirect` itself rather than the view reading the URL: a view that reads it needs a Suspense
// boundary, which React may stream after the shell, and without JavaScript a streamed boundary is never shown.
export default async function LoginPage({ searchParams }: LoginPageProps) {
  const { redirect } = await searchParams
  return (
    <LoginView
      redirect={typeof redirect === 'string' ? redirect : undefined}
      serverHtml={renderNymbal('nymbal-login-form').__html}
    />
  )
}
