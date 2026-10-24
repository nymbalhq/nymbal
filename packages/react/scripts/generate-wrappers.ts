import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ElementSchema } from '@nymbalhq/web-components'

type AttributeDef = ElementSchema['attributes'][number]
type EventDef = ElementSchema['events'][number]

function generatePropInterface(schema: ElementSchema): string {
  const lines: string[] = []
  for (const attr of schema.attributes) {
    const tsType =
      attr.type === 'boolean'
        ? 'boolean'
        : attr.type === 'number'
          ? 'number'
          : attr.type === 'json'
            ? 'unknown'
            : 'string'
    lines.push(`  ${attr.prop}?: ${tsType}`)
  }
  for (const evt of schema.events) {
    lines.push(`  ${evt.prop}?: (event: CustomEvent<${evt.detail}>) => void`)
  }
  lines.push(`  className?: string`)
  lines.push(`  style?: React.CSSProperties`)
  // The named slot this element fills in its parent element (the checkout's payment slot).
  lines.push(`  slot?: string`)
  lines.push(`  'data-testid'?: string`)
  if (!schema.children) {
    lines.push(`  /** The element's server render, \`renderNymbal(tag, …).__html\` from \`@nymbalhq/react/server\`. */`)
    lines.push(`  serverHtml?: string`)
    return `export interface ${schema.reactName}Props {\n${lines.join('\n')}\n}`
  }
  // React refuses children beside the server HTML set on the same tag: light-DOM children go into renderNymbal's.
  return `interface ${schema.reactName}OwnProps {\n${lines.join('\n')}\n}

export type ${schema.reactName}Props = ${schema.reactName}OwnProps &
  (
    | { children?: React.ReactNode; serverHtml?: undefined }
    /** The element's server render, \`renderNymbal(tag, …, children).__html\` from \`@nymbalhq/react/server\`. */
    | { children?: undefined; serverHtml?: string }
  )`
}

/**
 * The attribute as the JSX renders it, so a wrapper rendered on the server ships it: a JSON value stringified, a
 * boolean present (empty) or absent. The effects below keep it current after the element upgrades.
 */
function generateJsxAttribute(attr: AttributeDef): string {
  const value =
    attr.type === 'boolean'
      ? `props.${attr.prop} ? '' : undefined`
      : attr.type === 'json'
        ? `props.${attr.prop} === undefined ? undefined : JSON.stringify(props.${attr.prop})`
        : `props.${attr.prop}`
  return `${attr.name}={${value}}`
}

function generateAttrEffect(attr: AttributeDef): string {
  if (attr.type === 'boolean') {
    return `  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (props.${attr.prop}) {
      el.setAttribute('${attr.name}', '')
    } else {
      el.removeAttribute('${attr.name}')
    }
  }, [props.${attr.prop}])`
  }
  const value =
    attr.type === 'json' ? `JSON.stringify(props.${attr.prop})` : `String(props.${attr.prop})`
  return `  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (props.${attr.prop} !== undefined) {
      el.setAttribute('${attr.name}', ${value})
    } else {
      el.removeAttribute('${attr.name}')
    }
  }, [props.${attr.prop}])`
}

function generateEventEffect(evt: EventDef): string {
  return `  useEffect(() => {
    const el = ref.current
    if (!el || !props.${evt.prop}) return
    const handler = props.${evt.prop} as EventListener
    el.addEventListener('${evt.name}', handler)
    return () => el.removeEventListener('${evt.name}', handler)
  }, [props.${evt.prop}])`
}

function generateComponent(schema: ElementSchema): string {
  const attrEffects = schema.attributes.map(generateAttrEffect).join('\n\n')
  const eventEffects = schema.events.map(generateEventEffect).join('\n\n')
  const childSlot = schema.children ? `{props.children}` : ''
  const attributes = schema.attributes.map((a) => ` ${generateJsxAttribute(a)}`).join('')

  return `${generatePropInterface(schema)}

export const ${schema.reactName} = /* @__PURE__ */ forwardRef<HTMLElement, ${schema.reactName}Props>(
  function ${schema.reactName}(props, forwardedRef) {
    const innerRef = useRef<HTMLElement>(null)
    const ref = (forwardedRef ?? innerRef) as React.RefObject<HTMLElement | null>

${attrEffects}

${eventEffects}

    useDefine(${elementClass(schema)})

    return (
      <${schema.tag} ref={ref as React.Ref<HTMLElement>}${attributes} className={props.className} style={props.style} slot={props.slot} data-testid={props['data-testid']}
        // The server render goes on the tag itself: a full load parses its template into the shadow root, which React
        // does not see, and a soft navigation's innerHTML leaves it for the element to upgrade.
        dangerouslySetInnerHTML={props.serverHtml === undefined ? undefined : { __html: props.serverHtml }}
        suppressHydrationWarning={props.serverHtml !== undefined}>
        ${childSlot}
      </${schema.tag}>
    )
  },
)`
}

/**
 * The tag's JSX props: React's for any element, with the element's own attributes as the JSX sets them (JSON as its
 * text, a boolean as present or absent) in place of any React types under the same name (`results`).
 */
function intrinsicProps(schema: ElementSchema): string {
  const html = 'React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>'
  if (schema.attributes.length === 0) return html
  const names = schema.attributes.map((a) => `'${a.name}'`).join(' | ')
  const types = schema.attributes.map(
    (a) => `'${a.name}'?: ${a.type === 'number' ? 'number' : 'string'} | undefined`,
  )
  return `Omit<${html}, ${names}> & { ${types.join('; ')} }`
}

function generateIntrinsicElements(schemas: ElementSchema[]): string {
  const entries = schemas.map((s) => `      '${s.tag}': ${intrinsicProps(s)}`).join('\n')
  return `declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
${entries}
    }
  }
}`
}

/** The element's class, as its `elements/<tag>` entry exports it. */
function elementClass(schema: ElementSchema): string {
  return `Nymbal${schema.reactName}`
}

// The wrapper is what imports its element, and it is annotated pure, so a bundle that leaves a wrapper out leaves its
// element out too. The element is defined after the wrapper's attribute effects, so it upgrades with its attributes
// set, and a project that defined the tag first keeps its own element.
const USE_DEFINE = `/** Defines the wrapped element, and those it renders, once the wrapper mounts. */
function useDefine(element: { define(): void }): void {
  useEffect(() => {
    element.define()
  }, [element])
}`

/** The React wrappers module for these element schemas: one typed component per element. Pure. */
export function generateWrappers(schemas: ElementSchema[]): string {
  const imports = `import React, { forwardRef, useRef, useEffect } from 'react'`
  const elementImports = schemas
    .map((s) => `import { ${elementClass(s)} } from '@nymbalhq/web-components/elements/${s.tag}'`)
    .join('\n')
  const components = schemas.map(generateComponent).join('\n\n')

  return `// AUTO-GENERATED by scripts/generate-wrappers.ts from the element schemas — DO NOT EDIT
${imports}

${elementImports}

${generateIntrinsicElements(schemas)}

${USE_DEFINE}

${components}
`
}

/** Every element schema `@nymbalhq/web-components` exports, in export order. */
async function exportedSchemas(): Promise<ElementSchema[]> {
  const wc = (await import('@nymbalhq/web-components')) as Record<string, unknown>
  return Object.values(wc)
    .map((v) => (v as { schema?: ElementSchema } | null)?.schema)
    .filter((s): s is ElementSchema => s !== undefined)
}

function computeHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16)
}

/** The barrel the package exports: every wrapper and its props type, each from the wrapper's own module. */
function generateBarrel(schemas: ElementSchema[]): string {
  const lines = schemas.map(
    (s) =>
      `export { ${s.reactName}, type ${s.reactName}Props } from './wrappers/${s.reactName}.js'`,
  )
  return `// AUTO-GENERATED by scripts/generate-wrappers.ts from the element schemas — DO NOT EDIT
${lines.join('\n')}
`
}

/**
 * Every generated file under src/generated, by path: one module per wrapper, so a bundler that drops the modules
 * nothing imports drops a wrapper's element with it, and wrappers.tsx re-exporting them.
 */
function generatedFiles(schemas: ElementSchema[]): Map<string, string> {
  const files = new Map<string, string>()
  for (const schema of schemas) {
    files.set(`${WRAPPERS_DIR}/${schema.reactName}.tsx`, generateWrappers([schema]))
  }
  files.set('wrappers.tsx', generateBarrel(schemas))
  return files
}

const WRAPPERS_DIR = 'wrappers'

async function main(): Promise<void> {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const generatedDir = resolve(root, 'src/generated')
  const wrappersDir = resolve(generatedDir, WRAPPERS_DIR)
  const manifestPath = resolve(generatedDir, 'manifest.json')

  const schemas = await exportedSchemas()
  const files = generatedFiles(schemas)
  const sourceHash = computeHash(JSON.stringify(schemas))
  const recordedHash = existsSync(manifestPath)
    ? (JSON.parse(readFileSync(manifestPath, 'utf-8')) as { sourceHash?: string }).sourceHash
    : undefined
  // A wrapper module left behind by an element that no longer exists is stale too.
  const strays = existsSync(wrappersDir)
    ? readdirSync(wrappersDir)
        .map((name) => `${WRAPPERS_DIR}/${name}`)
        .filter((path) => !files.has(path))
    : []
  const wrappersCurrent =
    strays.length === 0 &&
    [...files].every(([path, content]) => {
      const file = resolve(generatedDir, path)
      return existsSync(file) && readFileSync(file, 'utf-8') === content
    })

  if (process.argv.includes('--check')) {
    if (recordedHash !== sourceHash || !wrappersCurrent) {
      console.error('Generated wrappers are stale. Run "pnpm generate" in packages/react.')
      process.exit(1)
    }
    console.log('Generated wrappers are up to date.')
    return
  }

  // A build runs this generator, so an unchanged source must leave the tracked files byte-identical: rewriting the
  // manifest would only move `generatedAt` and dirty the tree.
  if (recordedHash === sourceHash && wrappersCurrent) {
    process.stdout.write(`${schemas.length} React wrappers are up to date.\n`)
    return
  }

  mkdirSync(wrappersDir, { recursive: true })
  for (const stray of strays) rmSync(resolve(generatedDir, stray))
  for (const [path, content] of files) writeFileSync(resolve(generatedDir, path), content, 'utf-8')
  writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        sourceHash,
        components: schemas.map((s) => s.reactName),
      },
      null,
      2,
    ),
    'utf-8',
  )
  console.log(`Generated ${schemas.length} React wrappers.`)
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main()
}
