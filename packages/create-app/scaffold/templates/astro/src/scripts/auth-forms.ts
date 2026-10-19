import { client } from '../lib/client.js'
import { submitOnce } from '../lib/submit-once.js'

function getRedirectUrl(): string {
  const params = new URLSearchParams(window.location.search)
  return params.get('redirect') ?? '/account'
}

function showFormError(formId: string, message: string) {
  const errorEl = document.getElementById(`${formId}-error`)
  if (errorEl) {
    errorEl.textContent = message
    errorEl.style.display = 'block'
  }
}

function hideFormError(formId: string) {
  const errorEl = document.getElementById(`${formId}-error`)
  if (errorEl) {
    errorEl.style.display = 'none'
    errorEl.textContent = ''
  }
}

// Login form handler
const loginForm = document.getElementById('login-form') as HTMLFormElement | null
submitOnce(loginForm, async () => {
  hideFormError('login')

  const email = (document.getElementById('login-email') as HTMLInputElement)?.value
  const password = (document.getElementById('login-password') as HTMLInputElement)?.value

  if (!email || !password) {
    showFormError('login', 'Please enter your email and password.')
    return
  }

  const submitBtn = loginForm?.querySelector(
    '[data-testid="login-submit"]',
  ) as HTMLButtonElement | null
  if (submitBtn) submitBtn.textContent = 'Signing in...'

  try {
    await client.auth.login(email, password)
    window.location.href = getRedirectUrl()
    return 'leaving'
  } catch (err: any) {
    showFormError('login', err.message ?? 'Invalid email or password.')
    if (submitBtn) submitBtn.textContent = 'Sign In'
  }
})

// Register form handler
const registerForm = document.getElementById('register-form') as HTMLFormElement | null
submitOnce(registerForm, async () => {
  hideFormError('register')

  const email = (document.getElementById('register-email') as HTMLInputElement)?.value
  const password = (document.getElementById('register-password') as HTMLInputElement)?.value
  const firstName = (document.getElementById('register-firstName') as HTMLInputElement)?.value
  const lastName = (document.getElementById('register-lastName') as HTMLInputElement)?.value
  const phone = (document.getElementById('register-phone') as HTMLInputElement)?.value

  if (!email || !password) {
    showFormError('register', 'Please enter your email and password.')
    return
  }

  const submitBtn = registerForm?.querySelector(
    '[data-testid="register-submit"]',
  ) as HTMLButtonElement | null
  if (submitBtn) submitBtn.textContent = 'Creating account...'

  try {
    await client.auth.register({ email, password, firstName, lastName, phone })
    window.location.href = getRedirectUrl()
    return 'leaving'
  } catch (err: any) {
    showFormError('register', err.message ?? 'Registration failed. Please try again.')
    if (submitBtn) submitBtn.textContent = 'Create Account'
  }
})
