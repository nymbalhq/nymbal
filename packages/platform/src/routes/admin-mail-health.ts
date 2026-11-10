import type { EmailAdapter, HttpAdapter } from '@nymbalhq/types'
import { secureCookies, type NymbalConfig } from '@nymbalhq/config'
import type { Repositories } from '../repositories/index.js'
import type { AuthService } from '../services/auth-service.js'
import { emailDelivers } from '../services/index.js'
import { localSmtp, mailWarning, type MailFunnel } from '../services/mail-health.js'
import { ok, renderError } from './envelope.js'
import { requireRole } from './role-middleware.js'

const FUNNEL_DAYS = 7
const DAY_MS = 24 * 3_600_000
/** A sign-up still within its first hour has had no fair chance to confirm, so it is not counted yet. */
const FUNNEL_GRACE_MS = 3_600_000

export interface RegisterAdminMailHealthRouteDeps {
  config: NymbalConfig
  repos: Repositories
  auth: AuthService
  email: EmailAdapter
}

export function registerAdminMailHealthRoute(
  adapter: HttpAdapter,
  deps: RegisterAdminMailHealthRouteDeps,
): void {
  const { config, repos, auth, email } = deps

  adapter.registerRoute(
    'GET',
    '/api/admin/mail-health',
    requireRole('admin', async (ctx) => {
      try {
        const { verification } = auth
        let funnel: MailFunnel | null = null
        if (verification === 'required') {
          const now = Date.now()
          const counts = await repos.customer.store.read((tx) =>
            repos.customer.verificationFunnel(
              tx,
              new Date(now - FUNNEL_DAYS * DAY_MS),
              new Date(now - FUNNEL_GRACE_MS),
            ),
          )
          funnel = { days: FUNNEL_DAYS, ...counts }
        }
        const warning = mailWarning({
          verification,
          secure: secureCookies(config, process.env),
          localSmtp: localSmtp(config),
          delivers: emailDelivers(email),
          funnel,
        })
        return ok({ verification, funnel, warning })
      } catch (err) {
        return renderError(err, ctx.logger)
      }
    }),
  )
}
