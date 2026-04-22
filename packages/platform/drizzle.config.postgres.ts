import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/postgres.ts',
  out: './migrations/postgres',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://localhost:5432/nymbal',
  },
})
