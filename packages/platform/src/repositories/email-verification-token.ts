import type { CommandStore } from '../db/command-store.js'
import * as sqliteSchema from '../db/schema/sqlite.js'
import * as postgresSchema from '../db/schema/postgres.js'
import {
  createSingleUseTokenRepository,
  type SingleUseTokenRepository,
} from './password-reset-token.js'

/** A sign-up confirmation link's token, with a reset link's semantics: hashed, live until `expires_at`, used once. */
export type EmailVerificationTokenRepository = SingleUseTokenRepository

export function createEmailVerificationTokenRepository(
  store: CommandStore,
): EmailVerificationTokenRepository {
  return createSingleUseTokenRepository(store, {
    sqlite: sqliteSchema.emailVerificationTokens,
    postgres: postgresSchema.emailVerificationTokens,
  })
}
