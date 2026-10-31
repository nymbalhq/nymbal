import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

// `next start` for a Next build in the template directory, run as `node <this file>` through NYMBAL_STOREFRONT_ENTRY:
// HOST and PORT come from the environment as `nymbal start` gives them. `next-start.json` beside this file names the
// template directory and the build's dist directory (NYMBAL_NEXT_DIST_DIR, which next.config.mjs reads).

const { dir, distDir } = JSON.parse(
  readFileSync(new URL('./next-start.json', import.meta.url), 'utf8'),
)
process.env.NYMBAL_NEXT_DIST_DIR = distDir
process.env.NEXT_TELEMETRY_DISABLED = '1'
const require = createRequire(join(dir, 'package.json'))
const bin = require.resolve('next/dist/bin/next')
process.argv = [
  process.execPath,
  bin,
  'start',
  dir,
  '-H',
  process.env.HOST ?? '127.0.0.1',
  '-p',
  String(process.env.PORT),
]
require(bin)
