import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')

interface AttributeDef {
  name: string
  reactProp: string
  type: 'string' | 'boolean' | 'json' | 'number'
}

interface EventDef {
  name: string
  reactProp: string
  detailType: string
}

interface ComponentDef {
  tagName: string
  reactName: string
  attributes: AttributeDef[]
  events: EventDef[]
  hasChildren: boolean
}

const COMPONENTS: ComponentDef[] = [
  {
    tagName: 'nymbal-add-to-cart',
    reactName: 'AddToCart',
    attributes: [
      { name: 'variant-id', reactProp: 'variantId', type: 'string' },
      { name: 'disabled', reactProp: 'disabled', type: 'boolean' },
    ],
    events: [
      { name: 'nymbal:cart:item-added', reactProp: 'onItemAdded', detailType: '{ variantId: string }' },
    ],
    hasChildren: true,
  },
  {
    tagName: 'nymbal-cart-drawer',
    reactName: 'CartDrawer',
    attributes: [
      { name: 'open', reactProp: 'open', type: 'boolean' },
    ],
    events: [
      { name: 'nymbal:cart:checkout-clicked', reactProp: 'onCheckoutClick', detailType: 'void' },
    ],
    hasChildren: false,
  },
  {
    tagName: 'nymbal-mini-cart',
    reactName: 'MiniCart',
    attributes: [],
    events: [
      { name: 'nymbal:mini-cart:clicked', reactProp: 'onClick', detailType: 'void' },
    ],
    hasChildren: false,
  },
  {
    tagName: 'nymbal-variant-selector',
    reactName: 'VariantSelector',
    attributes: [
      { name: 'options', reactProp: 'options', type: 'json' },
    ],
    events: [
      { name: 'nymbal:variant:selected', reactProp: 'onVariantSelected', detailType: '{ variant: unknown }' },
    ],
    hasChildren: false,
  },
  {
    tagName: 'nymbal-quantity-selector',
    reactName: 'QuantitySelector',
    attributes: [
      { name: 'value', reactProp: 'value', type: 'number' },
      { name: 'min', reactProp: 'min', type: 'number' },
      { name: 'max', reactProp: 'max', type: 'number' },
    ],
    events: [
      { name: 'nymbal:quantity:changed', reactProp: 'onQuantityChange', detailType: '{ value: number }' },
    ],
    hasChildren: false,
  },
  {
    tagName: 'nymbal-search-bar',
    reactName: 'SearchBar',
    attributes: [
      { name: 'placeholder', reactProp: 'placeholder', type: 'string' },
      { name: 'debounce-ms', reactProp: 'debounceMs', type: 'number' },
    ],
    events: [
      { name: 'nymbal:search:selected', reactProp: 'onSearchSelect', detailType: '{ product: unknown }' },
    ],
    hasChildren: false,
  },
  {
    tagName: 'nymbal-product-filter',
    reactName: 'ProductFilter',
    attributes: [
      { name: 'facets', reactProp: 'facets', type: 'json' },
    ],
    events: [
      { name: 'nymbal:filter:changed', reactProp: 'onFilterChange', detailType: '{ name: string; value: string }' },
    ],
    hasChildren: false,
  },
  {
    tagName: 'nymbal-toast',
    reactName: 'Toast',
    attributes: [
      { name: 'position', reactProp: 'position', type: 'string' },
      { name: 'duration-ms', reactProp: 'durationMs', type: 'number' },
    ],
    events: [],
    hasChildren: false,
  },
]

function generatePropInterface(comp: ComponentDef): string {
  const lines: string[] = []
  for (const attr of comp.attributes) {
    const tsType = attr.type === 'boolean' ? 'boolean' : attr.type === 'number' ? 'number' : attr.type === 'json' ? 'unknown' : 'string'
    lines.push(`  ${attr.reactProp}?: ${tsType}`)
  }
  for (const evt of comp.events) {
    lines.push(`  ${evt.reactProp}?: (event: CustomEvent<${evt.detailType}>) => void`)
  }
  if (comp.hasChildren) {
    lines.push(`  children?: React.ReactNode`)
  }
  lines.push(`  className?: string`)
  lines.push(`  style?: React.CSSProperties`)
  return `export interface ${comp.reactName}Props {\n${lines.join('\n')}\n}`
}

function generateAttrEffect(attr: AttributeDef): string {
  if (attr.type === 'boolean') {
    return `  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (props.${attr.reactProp}) {
      el.setAttribute('${attr.name}', '')
    } else {
      el.removeAttribute('${attr.name}')
    }
  }, [props.${attr.reactProp}])`
  }
  if (attr.type === 'json') {
    return `  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (props.${attr.reactProp} !== undefined) {
      el.setAttribute('${attr.name}', JSON.stringify(props.${attr.reactProp}))
    } else {
      el.removeAttribute('${attr.name}')
    }
  }, [props.${attr.reactProp}])`
  }
  return `  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (props.${attr.reactProp} !== undefined) {
      el.setAttribute('${attr.name}', String(props.${attr.reactProp}))
    } else {
      el.removeAttribute('${attr.name}')
    }
  }, [props.${attr.reactProp}])`
}

function generateEventEffect(evt: EventDef): string {
  return `  useEffect(() => {
    const el = ref.current
    if (!el || !props.${evt.reactProp}) return
    const handler = props.${evt.reactProp} as EventListener
    el.addEventListener('${evt.name}', handler)
    return () => el.removeEventListener('${evt.name}', handler)
  }, [props.${evt.reactProp}])`
}

function generateComponent(comp: ComponentDef): string {
  const attrEffects = comp.attributes.map(generateAttrEffect).join('\n\n')
  const eventEffects = comp.events.map(generateEventEffect).join('\n\n')
  const childSlot = comp.hasChildren ? `{props.children}` : ''

  return `${generatePropInterface(comp)}

export const ${comp.reactName} = forwardRef<HTMLElement, ${comp.reactName}Props>(
  function ${comp.reactName}(props, forwardedRef) {
    const innerRef = useRef<HTMLElement>(null)
    const ref = (forwardedRef ?? innerRef) as React.RefObject<HTMLElement | null>

${attrEffects}

${eventEffects}

    return (
      <${comp.tagName} ref={ref as React.LegacyRef<HTMLElement>} className={props.className} style={props.style}>
        ${childSlot}
      </${comp.tagName}>
    )
  },
)`
}

function generateIntrinsicElements(): string {
  const entries = COMPONENTS.map(
    (c) => `      '${c.tagName}': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement>`,
  ).join('\n')
  return `declare global {
  namespace JSX {
    interface IntrinsicElements {
${entries}
    }
  }
}`
}

function generateOutput(): string {
  const imports = `import React, { forwardRef, useRef, useEffect } from 'react'`

  const components = COMPONENTS.map(generateComponent).join('\n\n')

  return `// AUTO-GENERATED by scripts/generate-wrappers.ts — DO NOT EDIT
${imports}

import '@nymbal/web-components'

${generateIntrinsicElements()}

${components}
`
}

function computeHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16)
}

const isCheck = process.argv.includes('--check')
const output = generateOutput()
const sourceHash = computeHash(JSON.stringify(COMPONENTS))
const outputPath = resolve(ROOT, 'src/generated/wrappers.tsx')
const manifestPath = resolve(ROOT, 'src/generated/manifest.json')

if (isCheck) {
  if (!existsSync(manifestPath)) {
    console.error('Generated wrappers not found. Run "pnpm generate" in packages/react.')
    process.exit(1)
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as { sourceHash: string }
  if (manifest.sourceHash !== sourceHash) {
    console.error('Generated wrappers are stale. Run "pnpm generate" in packages/react.')
    process.exit(1)
  }
  console.log('Generated wrappers are up to date.')
  process.exit(0)
}

writeFileSync(outputPath, output, 'utf-8')
writeFileSync(
  manifestPath,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      sourceHash,
      components: COMPONENTS.map((c) => c.reactName),
    },
    null,
    2,
  ),
  'utf-8',
)
console.log(`Generated ${COMPONENTS.length} React wrappers.`)
