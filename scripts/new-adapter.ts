// pnpm new-adapter <slot> <provider> [--from-provider <p>] [--from <dir>] [--dry-run]
//
// Scaffolds a first-party adapter at packages/adapters/<slot>/<provider>/ by copying a working adapter of the same
// slot, renamed, with its contract runner and fake; or moves a third party's package in with `--from <dir>`. It also
// lists the adapter where the repository lists adapters: registry/adapters.json, the catalogue in @nymbalhq/config,
// the root's and the kernel's devDependencies and the scaffold's exclusions, and writes a changeset.
// The guide is packages/adapters/README.md.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, posix, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** A refusal: one line naming the problem. Nothing has been written when it is thrown. */
export class NewAdapterError extends Error {}

export interface PlanInput {
  /** The slot, as its folder (`document-store`) or its config key (`documentStore`). */
  slot: string
  provider: string
  /** The first-party adapter to copy; the slot's default starting point when omitted. */
  fromProvider?: string
  /** An absolute path to a third party's package to move in. */
  fromDir?: string
}

export interface Plan {
  files: Array<{ path: string; content: string }>
  edits: Array<{ path: string; before: string; after: string }>
}

interface StartingPoint {
  /** The slot's folder spelling. */
  slot: string
  provider: string
  /** The identifier spelling of the provider (`EasyPost` in `createEasyPostShippingAdapter`). */
  ident: string
  /** Files outside the package that are copied and renamed with it: its contract runners and fake. */
  outside: readonly string[]
  /** Shared files and SDKs the copy imports unchanged. */
  shared: readonly string[]
  /** Files of the package, relative to it, a copy leaves out: they read what a copy does not carry (its recipes). */
  leaveOut?: readonly string[]
  /** The Vitest project its runners run in. */
  project: 'contracts-native'
  /** The slot's starting point when no --from-provider is given. */
  default?: true
}

/** The adapters a scaffold may start from. */
export const SOURCES: readonly StartingPoint[] = [
  {
    slot: 'email',
    provider: 'mailgun',
    ident: 'Mailgun',
    outside: ['tests/contracts/mailgun-email-feedback.test.ts', 'tests/support/mailgun.ts'],
    shared: ['tests/support/smtp-server.ts'],
    project: 'contracts-native',
    default: true,
  },
  {
    slot: 'email',
    provider: 'resend',
    ident: 'Resend',
    outside: ['tests/contracts/resend-email-feedback.test.ts', 'tests/support/resend.ts'],
    shared: ['tests/support/smtp-server.ts'],
    project: 'contracts-native',
  },
  {
    slot: 'email',
    provider: 'ses',
    ident: 'Ses',
    outside: ['tests/contracts/ses-email-feedback.test.ts', 'tests/support/ses.ts'],
    shared: ['tests/support/smtp-server.ts'],
    project: 'contracts-native',
  },
  {
    slot: 'email',
    provider: 'smtp',
    ident: 'Smtp',
    outside: ['tests/contracts/smtp-email.test.ts'],
    shared: ['tests/support/smtp-server.ts', 'tests/support/tcp-proxy.ts'],
    project: 'contracts-native',
  },
  {
    slot: 'payments',
    provider: 'stripe',
    ident: 'Stripe',
    outside: ['tests/contracts/stripe-payments.test.ts', 'tests/contracts/stripe-refunds.test.ts'],
    shared: ['tests/fixtures/stripe-api/server.mjs', 'stripe'],
    project: 'contracts-native',
    default: true,
  },
  {
    slot: 'search',
    provider: 'algolia',
    ident: 'Algolia',
    outside: ['tests/contracts/algolia-search.test.ts'],
    shared: [],
    project: 'contracts-native',
    default: true,
  },
  {
    slot: 'security',
    provider: 'cloudflare',
    ident: 'Cloudflare',
    outside: ['tests/contracts/cloudflare-security.test.ts'],
    shared: [],
    leaveOut: ['src/token-scopes.test.ts'],
    project: 'contracts-native',
    default: true,
  },
  {
    slot: 'shipping',
    provider: 'easypost',
    ident: 'EasyPost',
    outside: ['tests/contracts/easypost-shipping-tracking.test.ts', 'tests/support/easypost.ts'],
    shared: [],
    project: 'contracts-native',
    default: true,
  },
]

const PRIMITIVE =
  'a new document store, event bus or media store is kernel work: the kernel pins its primitives and their contract runs need Postgres, Redis or MinIO'

/** First-party adapters a scaffold does not start from, and why. */
export const REFUSED_SOURCES: ReadonlyArray<{ slot: string; provider: string; reason: string }> = [
  {
    slot: 'ai',
    provider: 'anthropic',
    reason:
      'the ai slot has no contract suite, so a copy would prove nothing; bring yours with --from <dir>',
  },
  { slot: 'document-store', provider: 'postgres-jsonb', reason: PRIMITIVE },
  { slot: 'document-store', provider: 'redis', reason: PRIMITIVE },
  { slot: 'event-bus', provider: 'redis-streams', reason: PRIMITIVE },
  { slot: 'media', provider: 's3', reason: PRIMITIVE },
]

/** SDK module specifiers and shared fakes: a copy imports them unchanged. */
const PROTECTED_SDKS = [
  'stripe',
  'nodemailer',
  '@anthropic-ai/sdk',
  '@aws-sdk/client-s3',
  'pg',
  'ioredis',
]
const SHARED_FAKES = [
  'support/smtp-server',
  'support/tcp-proxy',
  'support/fake-stripe',
  'stripe-api/',
]

/** Each slot's contract runner, by config key. */
const CONTRACT_RUNNERS: Readonly<Record<string, string>> = {
  payments: 'runPaymentsContract',
  email: 'runEmailContract',
  reviews: 'runReviewsContract',
  search: 'runSearchContract',
  analytics: 'runAnalyticsContract',
  shipping: 'runShippingContract',
  tax: 'runTaxContract',
  documentStore: 'runDocumentStoreContract',
  eventBus: 'runEventBusContract',
  media: 'runMediaStorageContract',
  security: 'runSecurityContract',
}

const GUIDE = 'packages/adapters/README.md'
const CATALOGUE_FILE = 'packages/config/src/adapter-names.ts'
const REGISTRY_FILE = 'registry/adapters.json'
const SYNC_SCAFFOLD = 'packages/create-app/scripts/sync-scaffold.mjs'
const KERNEL_MANIFEST = 'packages/platform/package.json'
/** The adapter whose build files a moved-in package takes when it has none. */
const CONVENTION = 'packages/adapters/search/algolia'

interface CatalogueEntry {
  builtIn?: true
  sdk?: string
}
type Catalogue = Record<string, Record<string, CatalogueEntry>>

interface Manifest {
  name?: string | undefined
  description?: string | undefined
  license?: string | undefined
  main?: string | undefined
  types?: string | undefined
  exports?: unknown
  files?: string[] | undefined
  scripts?: Record<string, string> | undefined
  dependencies?: Record<string, string> | undefined
  peerDependencies?: Record<string, string> | undefined
  devDependencies?: Record<string, string> | undefined
  [key: string]: unknown
}

interface RegistryEntry {
  package: string
  slot: string
  provider: string
  tier: string
  source: Record<string, unknown>
  [key: string]: unknown
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
const fail = (message: string): never => {
  throw new NewAdapterError(message)
}
const folderOf = (key: string): string => key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)

const read = (repo: string, path: string): string => readFileSync(join(repo, path), 'utf8')

/** The index of the brace that closes the one at `open`. */
function closing(text: string, open: number): number {
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++
    if (text[i] === '}' && --depth === 0) return i
  }
  return fail(`${CATALOGUE_FILE}: unbalanced braces`)
}

/** A slot's entry in ADAPTER_CATALOGUE as written: its braces and its provider entries (`stripe: { sdk: 'stripe' }`). */
interface SlotBlock {
  indent: string
  open: number
  close: number
  items: string[]
}

const providerOf = (item: string): string =>
  item.slice(0, item.indexOf(':')).trim().replace(/^'|'$/g, '')

/** ADAPTER_CATALOGUE's slot entries, read from the source text so a plan stays a plain read of the repository. */
function catalogueBlocks(text: string): Map<string, SlotBlock> {
  const start = text.indexOf('export const ADAPTER_CATALOGUE')
  const outer = text.indexOf('= {', start) + 2
  if (start === -1 || outer === 1) fail(`${CATALOGUE_FILE} has no ADAPTER_CATALOGUE`)
  const end = closing(text, outer)
  const blocks = new Map<string, SlotBlock>()
  const head = /^( *)(\w+): \{/gm
  head.lastIndex = outer + 1
  for (let m = head.exec(text); m !== null && m.index < end; m = head.exec(text)) {
    const open = m.index + m[0].length - 1
    const close = closing(text, open)
    const items: string[] = []
    let item = ''
    let depth = 0
    for (const c of text.slice(open + 1, close)) {
      if (c === '{') depth++
      if (c === '}') depth--
      if (c === ',' && depth === 0) {
        items.push(item.trim())
        item = ''
      } else item += c
    }
    if (item.trim() !== '') items.push(item.trim())
    blocks.set(m[2]!, { indent: m[1]!, open, close, items })
    head.lastIndex = close + 1
  }
  return blocks
}

function catalogueIn(repo: string): Catalogue {
  const blocks = catalogueBlocks(read(repo, CATALOGUE_FILE))
  return Object.fromEntries(
    [...blocks].map(([key, block]) => [
      key,
      Object.fromEntries(
        block.items.map((item): [string, CatalogueEntry] => {
          const sdk = /\bsdk:\s*'([^']+)'/.exec(item)?.[1]
          return [
            providerOf(item),
            /:\s*builtIn$/.test(item) ? { builtIn: true } : sdk === undefined ? {} : { sdk },
          ]
        }),
      ),
    ]),
  )
}

/**
 * The new provider's spellings: as given, in code, as a type, as a title outside code and as a constant. The title keeps
 * the hyphens so a protocol string lower-cased by its reader (an `X-Acme-Co-Key` header) matches the lower spelling.
 */
function spellingsOf(provider: string): {
  lower: string
  code: string
  ident: string
  title: string
  upper: string
} {
  const parts = provider.split('-')
  const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)
  return {
    lower: provider,
    code: parts[0]! + parts.slice(1).map(cap).join(''),
    ident: parts.map(cap).join(''),
    title: parts.map(cap).join('-'),
    upper: parts.map((p) => p.toUpperCase()).join('_'),
  }
}

/**
 * Which characters of a JavaScript or TypeScript text are code, rather than a string, template, regular expression or
 * comment. Where the source provider's name stands alone in code it is an identifier or a property name, so a
 * hyphenated new name is written there in camelCase or quoted.
 */
function codeMask(text: string): boolean[] {
  const code = new Array<boolean>(text.length).fill(false)
  const braces: number[] = []
  let depth = 0
  let last = ''
  let i = 0
  const regexAllowed = (): boolean =>
    last === '' ||
    '(,=:[!&|?{};+-*%<>~^'.includes(last) ||
    /\b(?:return|typeof|case|in|of|void|throw|new|else|do)$/.test(
      text.slice(Math.max(0, i - 7), i).trimEnd(),
    )
  while (i < text.length) {
    const c = text[i]!
    const next = text[i + 1]
    if (c === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i++
      continue
    }
    if (c === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end === -1 ? text.length : end + 2
      continue
    }
    if (c === "'" || c === '"') {
      i++
      while (i < text.length && text[i] !== c && text[i] !== '\n') i += text[i] === '\\' ? 2 : 1
      i++
      last = c
      continue
    }
    if (c === '`' || (c === '}' && braces.length > 0 && braces[braces.length - 1] === depth)) {
      if (c === '}') braces.pop()
      i++
      while (i < text.length && text[i] !== '`') {
        if (text[i] === '\\') i += 2
        else if (text[i] === '$' && text[i + 1] === '{') {
          braces.push(depth)
          i += 2
          break
        } else i++
      }
      if (text[i] === '`') i++
      last = '`'
      continue
    }
    if (c === '/' && regexAllowed()) {
      i++
      let inClass = false
      while (i < text.length && text[i] !== '\n' && (inClass || text[i] !== '/')) {
        if (text[i] === '\\') i++
        else if (text[i] === '[') inClass = true
        else if (text[i] === ']') inClass = false
        i++
      }
      i++
      while (i < text.length && /[a-z]/.test(text[i]!)) i++
      last = '/'
      continue
    }
    if (c === '{') depth++
    if (c === '}') depth--
    code[i] = true
    if (!/\s/.test(c)) last = c
    i++
  }
  return code
}

const isProtectedSpecifier = (spec: string): boolean =>
  PROTECTED_SDKS.some((sdk) => spec === sdk || spec.startsWith(`${sdk}/`)) ||
  SHARED_FAKES.some((fake) => spec.includes(fake))

/** The ranges of a text a rename leaves alone. */
function protectedRanges(
  text: string,
  source: StartingPoint,
  sourcePackage: string,
): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  // Quoted SDK specifiers and shared-fake paths. A quoted string that is the source provider's own name is a
  // provider name (`provider = 'stripe'`) unless it sits where a module or a dependency is named.
  const quoted = /(['"])((?:(?!\1)[^\n\\])*)\1/g
  for (const m of text.matchAll(quoted)) {
    const value = m[2]!
    if (!isProtectedSpecifier(value)) continue
    const before = text.slice(Math.max(0, m.index - 12), m.index)
    const after = text.slice(m.index + m[0].length)
    const named =
      /(?:\bfrom\s+|\bimport\s*\(?\s*|\bmock\(\s*|\brequire\(\s*)$/.test(before) ||
      /^\s*:/.test(after)
    const ownName = value === source.provider || value.startsWith(`${source.provider}/`)
    if (named || !ownName || SHARED_FAKES.some((f) => value.includes(f))) {
      ranges.push([m.index, m.index + m[0].length])
    }
  }
  // Every Nymbal package but the source's own.
  for (const m of text.matchAll(/@nymbalhq\/[a-z0-9-]+/g)) {
    if (m[0] !== sourcePackage) ranges.push([m.index, m.index + m[0].length])
  }
  // The names a file binds from a protected module.
  const imports = /\bimport\s+(?:type\s+)?([\s\S]*?)\s+from\s+(['"])([^'"\n]+)\2/g
  const bound = new Set(
    [...text.matchAll(imports)]
      .filter((m) => isProtectedSpecifier(m[3]!))
      .flatMap((m) => m[1]!.match(/[A-Za-z_$][\w$]*/g) ?? [])
      .filter((name) => name !== 'type' && name !== 'as'),
  )
  for (const name of bound) {
    for (const m of text.matchAll(new RegExp(`(?<![\\w$])${escape(name)}(?![\\w$])`, 'g'))) {
      ranges.push([m.index, m.index + m[0].length])
    }
  }
  return ranges
}

/** The bracket left open at `at`, among the code characters of a text, and where it is. */
function enclosingBracket(text: string, code: boolean[], at: number): [string, number] | undefined {
  let depth = 0
  for (let i = at - 1; i >= 0; i--) {
    if (code[i] !== true) continue
    if (')]}'.includes(text[i]!)) depth++
    else if ('([{'.includes(text[i]!) && depth-- === 0) return [text[i]!, i]
  }
  return undefined
}

/**
 * How the provider's name is used where it stands in code at `at`: as a member (`ids.cloudflare`), a key
 * (`{ cloudflare: … }`), a shorthand property (`{ cloudflare }`) or an identifier. A hyphenated new name keeps its lower
 * spelling as a property name, so a key matches the string that names it (`managedRulesets: ['acme-co']`).
 */
function propertyUse(
  text: string,
  code: boolean[],
  at: number,
  end: number,
): 'member' | 'key' | 'shorthand' | 'identifier' {
  if (text[at - 1] === '.' && text[at - 2] !== '.') return 'member'
  const bracket = enclosingBracket(text, code, at)
  if (bracket?.[0] !== '{') return 'identifier'
  if (/\b(?:import|export)\s+(?:type\s+)?$/.test(text.slice(0, bracket[1]))) return 'identifier'
  let p = at - 1
  while (p >= 0 && /\s/.test(text[p]!)) p--
  const startsMember =
    p < 0 ||
    '{,;'.includes(text[p]!) ||
    (text.slice(p + 1, at).includes('\n') && (code[p] !== true || /[\w$)\]}]/.test(text[p]!)))
  if (!startsMember) return 'identifier'
  const next = /^\s*(\??:(?!:)|[,}])/.exec(text.slice(end))?.[1]
  if (next === undefined) return 'identifier'
  return next.endsWith(':') ? 'key' : 'shorthand'
}

/** A text of the source with the source provider's lower, identifier and UPPER spellings renamed. */
function renameText(
  text: string,
  path: string,
  source: StartingPoint,
  provider: string,
  sourcePackage: string,
): string {
  const to = spellingsOf(provider)
  const ranges = protectedRanges(text, source, sourcePackage)
  const isScript = /\.(?:[cm]?[jt]sx?)$/.test(path)
  const code = isScript ? codeMask(text) : undefined
  const spelling = new RegExp(
    `(?<![a-z])(${escape(source.provider)})(?![a-z])|(?<![A-Z])(${escape(source.ident)})(?![a-z])|(?<![A-Z])(${escape(source.provider.toUpperCase())})(?![A-Z])`,
    'g',
  )
  const quoted = `'${to.lower}'`
  let out = ''
  let last = 0
  for (const m of text.matchAll(spelling)) {
    const at = m.index
    const end = at + m[0].length
    let renamed = m[0]
    if (!ranges.some(([from, until]) => at < until && end > from)) {
      const inCode = code?.[at] === true
      if (m[1] !== undefined && inCode && to.code !== to.lower) {
        const use = propertyUse(text, code!, at, end)
        renamed =
          use === 'key'
            ? quoted
            : use === 'shorthand'
              ? `${quoted}: ${to.code}`
              : use === 'member'
                ? `[${quoted}]`
                : to.code
        // `ids.cloudflare` becomes `ids['acme-co']`; `ids?.cloudflare` keeps its dot, `ids?.['acme-co']`.
        if (use === 'member' && text[at - 2] !== '?') {
          out += text.slice(last, at - 1)
          last = at
        }
      } else if (m[1] !== undefined) renamed = inCode ? to.code : to.lower
      else if (m[2] !== undefined) renamed = inCode ? to.ident : to.title
      else renamed = to.upper
    }
    out += text.slice(last, at) + renamed
    last = end
  }
  return out + text.slice(last)
}

/** A path of the source with the provider renamed. */
const renamePath = (path: string, source: StartingPoint, provider: string): string =>
  path.replace(new RegExp(`(?<![a-z])${escape(source.provider)}(?![a-z])`, 'g'), provider)

/** A runner outside the package imports it by relative path, so the copy resolves without an install. */
function importByPath(text: string, file: string, sourcePackage: string, dir: string): string {
  const target = posix.join(dir, 'src', 'index.js')
  const rel = posix.relative(posix.dirname(file), target)
  return text.replace(
    new RegExp(`(['"])${escape(sourcePackage)}\\1`, 'g'),
    (_all, q: string) => `${q}${rel.startsWith('.') ? rel : `./${rel}`}${q}`,
  )
}

const tracked = (repo: string, dir: string): string[] =>
  execFileSync('git', ['ls-files', '--', dir], { cwd: repo, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`

/** A manifest's dependency map with `name` added in sorted place. */
function withDependency(
  deps: Record<string, string>,
  name: string,
  range: string,
): Record<string, string> {
  const keys = Object.keys(deps)
  const at = keys.findIndex((k) => k.localeCompare(name) > 0)
  const order = at === -1 ? [...keys, name] : [...keys.slice(0, at), name, ...keys.slice(at)]
  return Object.fromEntries(order.map((k) => [k, k === name ? range : deps[k]!]))
}

function linkIn(
  repo: string,
  path: string,
  name: string,
): { path: string; before: string; after: string } {
  const before = read(repo, path)
  const manifest = JSON.parse(before) as Manifest
  manifest.devDependencies = withDependency(manifest.devDependencies ?? {}, name, 'workspace:*')
  return { path, before, after: json(manifest) }
}

/** registry/adapters.json as the repository writes it: one entry per block, a nested object on one line. */
function registryText(registry: { adapters: RegistryEntry[]; [key: string]: unknown }): string {
  const inline = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(inline).join(', ')}]`
    if (value !== null && typeof value === 'object') {
      const fields = Object.entries(value).map(([k, v]) => `${JSON.stringify(k)}: ${inline(v)}`)
      return fields.length === 0 ? '{}' : `{ ${fields.join(', ')} }`
    }
    return JSON.stringify(value)
  }
  const entry = (e: RegistryEntry): string =>
    `    {\n${Object.entries(e)
      .map(([k, v]) => `      ${JSON.stringify(k)}: ${inline(v)}`)
      .join(',\n')}\n    }`
  const { adapters, ...rest } = registry
  const others = Object.entries(rest).map(
    ([k, v]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`,
  )
  return `{\n${[...others, `  "adapters": [\n${adapters.map(entry).join(',\n')}\n  ]`].join(',\n')}\n}\n`
}

function registryEdit(
  repo: string,
  entry: RegistryEntry,
  replaces: string | undefined,
): { path: string; before: string; after: string } {
  const before = read(repo, REGISTRY_FILE)
  const registry = JSON.parse(before) as { adapters: RegistryEntry[] }
  const kept = registry.adapters.filter((e) => e.package !== replaces)
  const at = kept.findIndex((e) => e.package.localeCompare(entry.package) > 0)
  registry.adapters =
    at === -1 ? [...kept, entry] : [...kept.slice(0, at), entry, ...kept.slice(at)]
  return { path: REGISTRY_FILE, before, after: registryText(registry) }
}

/** ADAPTER_CATALOGUE with the provider added to its slot, the slot's providers kept in order. */
function catalogueEdit(
  repo: string,
  key: string,
  provider: string,
  entry: CatalogueEntry,
): { path: string; before: string; after: string } {
  const before = read(repo, CATALOGUE_FILE)
  const block = catalogueBlocks(before).get(key)
  if (block === undefined)
    fail(`${CATALOGUE_FILE} has no ${folderOf(key)} entry in ADAPTER_CATALOGUE`)
  const { items, indent, open, close } = block!
  const keyText = /^[a-z_$][\w$]*$/.test(provider) ? provider : `'${provider}'`
  const value = entry.sdk === undefined ? '{}' : `{ sdk: '${entry.sdk}' }`
  const added = `${keyText}: ${value}`
  const at = items.findIndex(
    (it) => !/:\s*builtIn$/.test(it) && providerOf(it).localeCompare(provider) > 0,
  )
  const next = at === -1 ? [...items, added] : [...items.slice(0, at), added, ...items.slice(at)]
  const multiline = before.slice(open, close).includes('\n')
  const oneLine = `{ ${next.join(', ')} }`
  const lineStart = before.lastIndexOf('\n', open) + 1
  const body =
    !multiline && before.slice(lineStart, open).length + oneLine.length + 1 <= 100
      ? oneLine
      : `{\n${next.map((it) => `${indent}  ${it},`).join('\n')}\n${indent}}`
  return {
    path: CATALOGUE_FILE,
    before,
    after: `${before.slice(0, open)}${body}${before.slice(close + 1)}`,
  }
}

/** sync-scaffold.mjs's NON_SCAFFOLD_PACKAGES with the package added in sorted place. */
function syncScaffoldEdit(
  repo: string,
  name: string,
): { path: string; before: string; after: string } {
  const before = read(repo, SYNC_SCAFFOLD)
  const lines = before.split('\n')
  const start = lines.findIndex((l) => l.includes('NON_SCAFFOLD_PACKAGES'))
  const end = lines.findIndex((l, i) => i > start && l.includes('])'))
  if (start === -1 || end === -1) fail(`${SYNC_SCAFFOLD} has no NON_SCAFFOLD_PACKAGES list`)
  const entry = /^(\s*)'(@nymbalhq\/[a-z0-9-]+)',\s*$/
  const entries = lines
    .map((l, i) => ({ i, m: entry.exec(l) }))
    .filter((e) => e.i > start && e.i < end && e.m !== null)
  const after = entries.find((e) => e.m![2]!.localeCompare(name) > 0)
  const indent = entries[0]?.m![1] ?? '  '
  const at = after?.i ?? (entries.length > 0 ? entries[entries.length - 1]!.i + 1 : end)
  lines.splice(at, 0, `${indent}'${name}',`)
  return { path: SYNC_SCAFFOLD, before, after: lines.join('\n') }
}

function changeset(
  repo: string,
  name: string,
  slot: string,
  provider: string,
): { path: string; content: string } {
  const path = `.changeset/add-${slot}-${provider}.md`
  if (existsSync(join(repo, path)))
    fail(`${path} already exists: remove it or pick another provider name`)
  return {
    path,
    content: `---\n'${name}': minor\n'@nymbalhq/config': minor\n---\n\nAdd the \`${provider}\` ${slot} adapter, \`${name}\`.\n`,
  }
}

/** Every file of a third party's package worth moving: no installs, builds, lockfiles, changelog or recipes. */
function filesOf(dir: string): string[] {
  const anywhere = new Set(['node_modules', 'dist', '.git'])
  const atRoot = new Set([
    'recipes',
    'CHANGELOG.md',
    'package.json',
    'package-lock.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    'bun.lockb',
  ])
  const walk = (rel: string): string[] =>
    readdirSync(join(dir, rel)).flatMap((entry) => {
      if (anywhere.has(entry) || (rel === '' && atRoot.has(entry))) return []
      const path = rel === '' ? entry : `${rel}/${entry}`
      return statSync(join(dir, path)).isDirectory() ? walk(path) : [path]
    })
  return walk('')
}

/** The plan: the files to write and the edits to make. Reads the repository, writes nothing. */
export function planAdapter(input: PlanInput, repo: string): Plan {
  const catalogue = catalogueIn(repo)
  const keys = Object.keys(catalogue)
  const key = keys.find((k) => k === input.slot || folderOf(k) === input.slot)
  if (key === undefined) {
    fail(`unknown slot '${input.slot}': one of ${keys.map(folderOf).join(', ')}`)
  }
  const slot = folderOf(key!)
  const { provider } = input
  const providerName = /^[a-z0-9][a-z0-9-]{0,63}$/
  if (!providerName.test(provider)) {
    fail(
      `'${provider}' is not a provider name: lower-case letters, digits and hyphens, starting with a letter or digit, at most 64 characters`,
    )
  }
  if (Object.hasOwn(catalogue[key!]!, provider)) {
    fail(`the ${slot} slot already has a provider named '${provider}' (${CATALOGUE_FILE})`)
  }
  const dir = `packages/adapters/${slot}/${provider}`
  if (existsSync(join(repo, dir))) {
    fail(`${dir} already exists: the scaffold never writes over an adapter, finished or not`)
  }
  const name = `@nymbalhq/${slot}-${provider}`
  if (input.fromDir !== undefined && input.fromProvider !== undefined) {
    fail('give --from <dir> or --from-provider <provider>, not both')
  }

  const plan =
    input.fromDir !== undefined
      ? moveIn(repo, key!, slot, provider, name, dir, input.fromDir)
      : copy(repo, key!, slot, provider, name, dir, input.fromProvider, catalogue)
  const taken = plan.files.find((f) => existsSync(join(repo, f.path)))
  if (taken !== undefined)
    fail(`${taken.path} already exists: the scaffold never writes over a file`)
  return plan
}

function copy(
  repo: string,
  key: string,
  slot: string,
  provider: string,
  name: string,
  dir: string,
  fromProvider: string | undefined,
  catalogue: Catalogue,
): Plan {
  // A copy names its functions, types and constants after the provider, and none of them may start with a digit.
  if (/^[0-9]/.test(provider)) {
    fail(
      `'${provider}' starts with a digit, which a copy's code cannot be named after: start it with a letter, or bring yours with --from <dir>`,
    )
  }
  const refused = REFUSED_SOURCES.find(
    (r) => r.slot === slot && (fromProvider === undefined || r.provider === fromProvider),
  )
  const sources = SOURCES.filter((s) => s.slot === slot)
  if (fromProvider === undefined && sources.length === 0) {
    fail(
      `the ${slot} slot has no adapter to start from: bring yours with --from <dir> (see ${GUIDE})`,
    )
  }
  if (fromProvider !== undefined && refused !== undefined) {
    fail(`${slot}/${fromProvider} is not a starting point: ${refused.reason} (see ${GUIDE})`)
  }
  const source =
    fromProvider === undefined
      ? sources.find((s) => s.default === true)!
      : sources.find((s) => s.provider === fromProvider)
  if (source === undefined) {
    fail(
      `${slot}/${fromProvider} is not a starting point: start from ${sources.map((s) => s.provider).join(', ') || 'none'}, or bring yours with --from <dir> (see ${GUIDE})`,
    )
  }
  const from = source!
  const sourceDir = `packages/adapters/${slot}/${from.provider}`
  const sourcePackage = `@nymbalhq/${slot}-${from.provider}`

  const files: Plan['files'] = []
  for (const file of tracked(repo, sourceDir)) {
    if (file.endsWith('/CHANGELOG.md') || file.startsWith(`${sourceDir}/recipes/`)) continue
    if (from.leaveOut?.includes(file.slice(sourceDir.length + 1)) === true) continue
    const path = `${dir}${renamePath(file.slice(sourceDir.length), from, provider)}`
    let text = read(repo, file)
    if (file === `${sourceDir}/package.json`) {
      const manifest = JSON.parse(text) as Manifest
      manifest.version = '0.0.0'
      manifest.files = manifest.files?.filter((f) => f !== 'recipes')
      if (manifest.exports !== null && typeof manifest.exports === 'object') {
        const { ['./recipes/*']: _recipes, ...exports } = manifest.exports as Record<
          string,
          unknown
        >
        manifest.exports = exports
      }
      text = json(manifest)
    }
    files.push({ path, content: renameText(text, path, from, provider, sourcePackage) })
  }
  for (const file of from.outside) {
    const path = renamePath(file, from, provider)
    const text = importByPath(read(repo, file), path, sourcePackage, dir)
    files.push({ path, content: renameText(text, path, from, provider, sourcePackage) })
  }
  files.push(changeset(repo, name, slot, provider))

  const sdk = catalogue[key]![from.provider]?.sdk
  return {
    files,
    edits: [
      registryEdit(
        repo,
        { package: name, slot, provider, tier: 'first-party', source: { dir } },
        undefined,
      ),
      catalogueEdit(repo, key, provider, sdk === undefined ? {} : { sdk }),
      linkIn(repo, 'package.json', name),
      linkIn(repo, KERNEL_MANIFEST, name),
      syncScaffoldEdit(repo, name),
    ],
  }
}

function moveIn(
  repo: string,
  key: string,
  slot: string,
  provider: string,
  name: string,
  dir: string,
  fromDir: string,
): Plan {
  if (!isAbsolute(fromDir))
    fail(`--from ${fromDir}: give the package's directory as an absolute path`)
  if (!existsSync(join(fromDir, 'package.json'))) fail(`--from ${fromDir}: no package.json there`)
  const theirs = JSON.parse(readFileSync(join(fromDir, 'package.json'), 'utf8')) as Manifest
  const thirdParty = theirs.name ?? ''
  const starting = SOURCES.find((s) => s.slot === slot && s.default === true)
  const conventionDir =
    starting === undefined ? CONVENTION : `packages/adapters/${slot}/${starting.provider}`
  const convention = JSON.parse(read(repo, `${conventionDir}/package.json`)) as Manifest
  const root = JSON.parse(read(repo, 'package.json')) as Manifest
  const named = (text: string): string =>
    thirdParty === '' ? text : text.split(thirdParty).join(name)

  const { ['./recipes/*']: _recipes, ...exports } = (convention.exports ?? {}) as Record<
    string,
    unknown
  >
  const sdks = Object.keys(theirs.peerDependencies ?? {}).filter((d) => !d.startsWith('@nymbalhq/'))
  const manifest: Manifest = {
    name,
    version: '0.0.0',
    ...(theirs.description === undefined ? {} : { description: named(theirs.description) }),
    license: root.license,
    repository: { ...(convention['repository'] as object), directory: dir },
    publishConfig: convention['publishConfig'],
    type: 'module',
    engines: convention['engines'],
    main: convention.main,
    types: convention.types,
    exports,
    files: ['dist'],
    scripts: {
      ...theirs.scripts,
      build: convention.scripts?.['build'] ?? 'tsup',
      typecheck: convention.scripts?.['typecheck'] ?? 'tsc -p tsconfig.json --noEmit',
    },
    ...(theirs.dependencies === undefined ? {} : { dependencies: theirs.dependencies }),
    peerDependencies: {
      ...theirs.peerDependencies,
      '@nymbalhq/types': convention.peerDependencies?.['@nymbalhq/types'] ?? '*',
    },
    devDependencies: { ...convention.devDependencies, ...theirs.devDependencies },
  }

  const files: Plan['files'] = [{ path: `${dir}/package.json`, content: json(manifest) }]
  const given = filesOf(fromDir)
  for (const file of given) {
    files.push({
      path: `${dir}/${file}`,
      content: named(readFileSync(join(fromDir, file), 'utf8')),
    })
  }
  for (const build of ['tsconfig.json', 'tsup.config.ts']) {
    if (!given.includes(build))
      files.push({ path: `${dir}/${build}`, content: read(repo, `${CONVENTION}/${build}`) })
  }
  const runner = CONTRACT_RUNNERS[key]
  if (runner !== undefined) {
    const path = `tests/contracts/${provider}-${slot}.test.ts`
    const entry = posix.relative('tests/contracts', `${dir}/src/index.js`)
    files.push({
      path,
      content: [
        `import { ${runner} } from '@nymbalhq/contract-tests'`,
        `import * as adapter from '${entry}'`,
        '',
        `// The package certified as \`nymbal test:contracts --package\` certifies it: \`contractOptions.options\` builds an`,
        `// adapter against the provider's fake, and \`contractOptions.unreachable\` one whose provider cannot be reached.`,
        `type Built = Awaited<ReturnType<Parameters<typeof ${runner}>[1]>>`,
        'const { createAdapter, contractOptions } = adapter as unknown as {',
        '  createAdapter: (config: unknown) => Built | Promise<Built>',
        '  contractOptions?: { options?: unknown; unreachable?: unknown }',
        '}',
        'const { options = {}, unreachable } = contractOptions ?? {}',
        '',
        'async function build(config: unknown): Promise<Built> {',
        '  const built = await createAdapter(config)',
        '  await (built as { initialize?: (config: unknown) => Promise<void> }).initialize?.(config)',
        '  return built',
        '}',
        '',
        `${runner}('${name}', () => build(options), {`,
        '  ...(unreachable !== undefined && { unreachable: () => build(unreachable) }),',
        `} as Parameters<typeof ${runner}>[2])`,
        '',
      ].join('\n'),
    })
  }
  files.push(changeset(repo, name, slot, provider))

  const sdk = sdks.length === 1 ? sdks[0] : undefined
  return {
    files,
    edits: [
      registryEdit(
        repo,
        { package: name, slot, provider, tier: 'first-party', source: { dir } },
        thirdParty,
      ),
      catalogueEdit(repo, key, provider, sdk === undefined ? {} : { sdk }),
      linkIn(repo, 'package.json', name),
      linkIn(repo, KERNEL_MANIFEST, name),
      syncScaffoldEdit(repo, name),
    ],
  }
}

/** Writes the plan. An edited file that changed since it was planned stops it before anything is written. */
export function applyPlan(plan: Plan, repo: string): void {
  for (const edit of plan.edits) {
    if (read(repo, edit.path) !== edit.before)
      fail(`${edit.path} changed since the plan was made: run it again`)
  }
  for (const file of plan.files) {
    mkdirSync(dirname(join(repo, file.path)), { recursive: true })
    writeFileSync(join(repo, file.path), file.content)
  }
  for (const edit of plan.edits) writeFileSync(join(repo, edit.path), edit.after)
}

const USAGE =
  'usage: pnpm new-adapter <slot> <provider> [--from-provider <provider>] [--from <dir>] [--dry-run]'

function main(argv: string[]): number {
  const args: string[] = []
  let fromProvider: string | undefined
  let fromDir: string | undefined
  let dryRun = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--dry-run') dryRun = true
    else if (a === '--from-provider') fromProvider = argv[++i]
    else if (a === '--from') fromDir = argv[++i]
    else if (a === '--help' || a === '-h') {
      process.stdout.write(`${USAGE}\n`)
      return 0
    } else args.push(a)
  }
  const [slot, provider] = args
  if (slot === undefined || provider === undefined || args.length > 2) {
    console.error(USAGE)
    return 1
  }
  const repo = fileURLToPath(new URL('..', import.meta.url))
  // pnpm runs a root script from the root: a relative --from is relative to where the contributor stood.
  const cwd = process.env['INIT_CWD'] ?? process.cwd()
  const input: PlanInput = {
    slot,
    provider,
    ...(fromProvider === undefined ? {} : { fromProvider }),
    ...(fromDir === undefined ? {} : { fromDir: resolve(cwd, fromDir) }),
  }
  let plan: Plan
  try {
    plan = planAdapter(input, repo)
    if (!dryRun) applyPlan(plan, repo)
  } catch (error) {
    if (!(error instanceof NewAdapterError)) throw error
    console.error(`new-adapter: ${error.message}`)
    return 1
  }
  const runners = plan.files.map((f) => f.path).filter((p) => p.startsWith('tests/contracts/'))
  const dir = `packages/adapters/${plan.files[0]!.path.split('/').slice(2, 4).join('/')}`
  const lines = [
    dryRun ? 'Would write:' : 'Wrote:',
    ...plan.files.map((f) => `  ${f.path}`),
    dryRun ? 'Would edit:' : 'Edited:',
    ...plan.edits.map((e) => `  ${e.path}`),
    ...(dryRun
      ? []
      : [
          '',
          'Next:',
          '  pnpm install',
          ...(runners.length > 0
            ? [`  pnpm vitest run --project contracts-native ${runners.join(' ')}`]
            : []),
          `  pnpm vitest run ${dir}/`,
          '  pnpm gate',
          `Then replace the provider calls, the fake and the README: see ${GUIDE}.`,
        ]),
  ]
  process.stdout.write(`${lines.join('\n')}\n`)
  return 0
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  process.exitCode = main(process.argv.slice(2))
}
