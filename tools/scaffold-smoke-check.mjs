#!/usr/bin/env node
/**
 * Smoke-checks a scaffolded storefront by fetching / and /products,
 * verifying 200 responses and expected content markers.
 *
 * Usage: node tools/scaffold-smoke-check.mjs --port 4321
 */

const args = process.argv.slice(2)
let port = 4321

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port' && args[i + 1]) {
    port = Number(args[i + 1])
    i++
  } else if (args[i]?.startsWith('--port=')) {
    port = Number(args[i].slice('--port='.length))
  }
}

const base = `http://localhost:${port}`

const checks = [
  { path: '/', marker: 'hero-section', description: 'homepage has hero section' },
  { path: '/products', marker: 'product-card-', description: 'products page has product cards' },
]

let failed = false

for (const { path, marker, description } of checks) {
  const url = `${base}${path}`
  try {
    const res = await fetch(url)
    if (!res.ok) {
      process.stderr.write(`FAIL ${url} — HTTP ${res.status}\n`)
      failed = true
      continue
    }
    const body = await res.text()
    if (!body.includes(marker)) {
      process.stderr.write(`FAIL ${url} — missing marker "${marker}" (${description})\n`)
      failed = true
      continue
    }
    process.stdout.write(`OK   ${url} — ${description}\n`)
  } catch (err) {
    process.stderr.write(`FAIL ${url} — ${err.message}\n`)
    failed = true
  }
}

if (failed) {
  process.exit(1)
}
