#!/usr/bin/env node
// Syncs templates/astro and templates/nextjs into scaffold/templates/* so the scaffolder
// always copies from a single canonical source.
import { cp, mkdir, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PKG_ROOT = resolve(HERE, '..')
const MONOREPO_ROOT = resolve(PKG_ROOT, '..', '..')
const SCAFFOLD_TEMPLATES = resolve(PKG_ROOT, 'scaffold', 'templates')

const templates = [
  { name: 'astro', from: resolve(MONOREPO_ROOT, 'templates', 'astro') },
  { name: 'nextjs', from: resolve(MONOREPO_ROOT, 'templates', 'nextjs') },
]

async function main() {
  await mkdir(SCAFFOLD_TEMPLATES, { recursive: true })
  for (const t of templates) {
    const dest = resolve(SCAFFOLD_TEMPLATES, t.name)
    await rm(dest, { recursive: true, force: true })
    await mkdir(dest, { recursive: true })
    await cp(t.from, dest, {
      recursive: true,
      filter: (src) =>
        !src.includes('node_modules') &&
        !src.endsWith('dist') &&
        !src.endsWith('.astro') &&
        !src.endsWith('.next'),
    })
    // eslint-disable-next-line no-console
    console.log(`✓ synced scaffold/templates/${t.name}`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
