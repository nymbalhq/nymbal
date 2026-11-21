import { request as playwrightRequest } from '@playwright/test'
import { linksIn, linkTo, mailbox, type Mail } from './alerts'
import { API_URL, csrf } from './csrf'
import { expect } from './fixtures'
import type { Shopper } from './passwords'

// What the sign-up journeys share. A store whose mail delivers asks a new address to confirm it: register answers 202
// "check your email" and the account signs in only from the mailed link. A journey that needs a signed-in shopper on
// such a store (the Mailpit stores) registers through `registerVerified`, which follows the link from Mailpit as the
// shopper would; on a store that does not confirm (the native stores) register signs in at once and the helper returns
// that session. No product code holds a test-only way to a confirmed shopper.

export const VERIFY_PATH = '/account/verify-email'
const TOKEN = /^#token=([A-Za-z0-9_-]{43})$/

/** A confirmation mail carries a link to the verify page. */
export const isVerifyMail = (mail: Mail): boolean =>
  linksIn(mail).some((url) => url.pathname === VERIFY_PATH)

/** An "account exists" mail links to the sign-in page and to Forgot password, and to no verify page. */
export const isAccountExistsMail = (mail: Mail): boolean => {
  const paths = linksIn(mail).map((url) => url.pathname)
  return (
    paths.includes('/account/login') &&
    paths.includes('/account/forgot-password') &&
    !paths.includes(VERIFY_PATH)
  )
}

/** The token in a confirmation mail's link; the journey depends on it. */
export function verifyTokenIn(mail: Mail): string {
  const link = linkTo(mail, VERIFY_PATH)
  const match = TOKEN.exec(link.hash)
  expect(match, `the confirmation link: ${link.href}`).not.toBeNull()
  return match![1]!
}

/** The confirmation mails at `email` once `count` mails in all have reached it. */
export async function verifyMailsTo(email: string, count: number): Promise<Mail[]> {
  const mail = await mailbox()
  return (await mail.waitFor(email, count)).filter(isVerifyMail)
}

async function postRegister(shopper: Shopper) {
  const context = await playwrightRequest.newContext()
  const res = await context.post(`${API_URL}/api/auth/register`, {
    headers: await csrf(context),
    data: {
      email: shopper.email,
      password: shopper.password,
      firstName: 'Ada',
      lastName: 'Verified',
    },
  })
  return { context, res }
}

/**
 * Registers `shopper` on a store that confirms addresses and answers the token of the one confirmation mail it sent,
 * the account left pending.
 */
export async function registerPending(shopper: Shopper): Promise<string> {
  const { context, res } = await postRegister(shopper)
  try {
    expect(res.status(), `POST /api/auth/register: ${await res.text()}`).toBe(202)
  } finally {
    await context.dispose()
  }
  const mails = await verifyMailsTo(shopper.email, 1)
  expect(mails.length, `confirmation mails to ${shopper.email}`).toBe(1)
  return verifyTokenIn(mails[0]!)
}

/**
 * Registers `shopper` through the API and answers a session: the register's own on a store that signs in at once
 * (201), else the one following the mailed link gives (202, then `POST /api/auth/verify-email`).
 */
export async function registerVerified(shopper: Shopper): Promise<{ accessToken: string }> {
  const { context, res } = await postRegister(shopper)
  try {
    const text = await res.text()
    if (res.status() === 201) {
      return {
        accessToken: (JSON.parse(text) as { data: { accessToken: string } }).data.accessToken,
      }
    }
    expect(res.status(), `POST /api/auth/register: ${text}`).toBe(202)
    const [mail] = await verifyMailsTo(shopper.email, 1)
    expect(mail, `a confirmation mail to ${shopper.email}`).not.toBeUndefined()
    const verified = await context.post(`${API_URL}/api/auth/verify-email`, {
      headers: await csrf(context),
      data: { token: verifyTokenIn(mail!) },
    })
    const body = await verified.text()
    expect(verified.status(), `POST /api/auth/verify-email: ${body}`).toBe(200)
    return { accessToken: (JSON.parse(body) as { data: { accessToken: string } }).data.accessToken }
  } finally {
    await context.dispose()
  }
}

/** Asks for a reset link for `email` through the API: a later mail to the address, so earlier sends have landed. */
export async function forgotThroughApi(email: string): Promise<void> {
  const context = await playwrightRequest.newContext()
  try {
    const res = await context.post(`${API_URL}/api/auth/forgot-password`, {
      headers: await csrf(context),
      data: { email },
    })
    expect(res.status(), `POST /api/auth/forgot-password: ${await res.text()}`).toBe(202)
  } finally {
    await context.dispose()
  }
}

/** The sign-up policy GET /api/capabilities reports; a report without the field reads as no answer. */
export function verificationOf(caps: unknown): unknown {
  return (caps as { auth?: { verification?: unknown } }).auth?.verification
}
