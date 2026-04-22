import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema/sqlite.ts',
  out: './migrations/sqlite',
  dbCredentials: {
    url: process.env.NYMBAL_SQLITE_PATH ?? './nymbal.db',
  },
})
