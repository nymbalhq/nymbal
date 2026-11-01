import fc from 'fast-check'
import * as React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import { cleanup, render } from '@testing-library/react'
import ts from 'typescript'
import { afterEach, describe, expect, it } from 'vitest'
import * as wc from '@nymbalhq/web-components'
import type { ElementSchema } from '@nymbalhq/web-components'
import { generateWrappers } from '../../scripts/generate-wrappers.js'
import * as committed from './wrappers.js'

// AC-1: a wrapper's element has every attribute its props set, and the property Lit derives from it, when it first
// connects: whether the tag was defined before the wrapper rendered (a second instance, or a page that defined it
// first) or is defined by the wrapper. The elements read their attributes as they connect and render (the payment
// element mounts its client from `client`, add-to-cart reads `qty` and `disabled`), so one that is missing then
// renders the element's default first. React sets a prop the element has a same-named property for (`qty`, `client`,
// `disabled`) as that property, not the attribute, so an attribute set in an effect arrives after the element connected.

type Attribute = ElementSchema['attributes'][number]
type AttrType = Attribute['type']
type Wrapper = React.ComponentType<Record<string, unknown>>

/** What an element saw of its attributes and properties at its first `connectedCallback`, keyed by prop. */
interface Seen {
  attributes: Record<string, unknown>
  properties: Record<string, unknown>
}

/** Lit's conversion of an attribute to its property (JSON travels as a String property, see `propertiesOf`). */
function fromAttribute(type: AttrType, raw: string | null): unknown {
  if (type === 'boolean') return raw !== null
  if (raw === null) return undefined
  if (type === 'number') return Number(raw)
  return raw
}

/** The attribute, read back as the prop value that set it. */
function readAttribute(type: AttrType, raw: string | null): unknown {
  return type === 'json' && raw !== null ? (JSON.parse(raw) as unknown) : fromAttribute(type, raw)
}

/**
 * The property, read back as the prop value that set it: `parsedJson` parses a JSON property's string, and a boolean
 * property never set keeps the element's default, false.
 */
function readProperty(type: AttrType, value: unknown): unknown {
  if (type === 'boolean') return value === true
  return type === 'json' && typeof value === 'string' ? (JSON.parse(value) as unknown) : value
}

/**
 * A stand-in for the element with Lit's shape: an accessor on the prototype for each prop, each observed attribute
 * converted to its property. It records what it saw at its first `connectedCallback` into `seen`.
 */
function litLike(schema: ElementSchema, seen: Seen[]): CustomElementConstructor {
  class Element extends HTMLElement {
    static observedAttributes = schema.attributes.map((a) => a.name)
    values = new Map<string, unknown>()
    connected = false
    attributeChangedCallback(name: string, _old: string | null, raw: string | null): void {
      const a = schema.attributes.find((x) => x.name === name)!
      this.values.set(a.prop, fromAttribute(a.type, raw))
    }
    connectedCallback(): void {
      if (this.connected) return
      this.connected = true
      seen.push({
        attributes: Object.fromEntries(
          schema.attributes.map((a) => [a.prop, readAttribute(a.type, this.getAttribute(a.name))]),
        ),
        properties: Object.fromEntries(
          schema.attributes.map((a) => [a.prop, readProperty(a.type, this.values.get(a.prop))]),
        ),
      })
    }
  }
  for (const a of schema.attributes) {
    Object.defineProperty(Element.prototype, a.prop, {
      configurable: true,
      get(this: Element) {
        return this.values.get(a.prop)
      },
      set(this: Element, value: unknown) {
        this.values.set(a.prop, value)
      },
    })
  }
  return Element
}

/**
 * Generates the wrappers for `schemas`, compiles the TSX and evaluates it with React. Each element's `define()` defines
 * `classes`' entry for its tag, as the real elements do, unless the tag is defined already.
 */
function load(
  schemas: ElementSchema[],
  classes: Map<string, CustomElementConstructor>,
): Record<string, Wrapper> {
  const { outputText } = ts.transpileModule(generateWrappers(schemas), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true,
    },
  })
  const modules: Record<string, unknown> = {
    react: React,
    'react/jsx-runtime': jsxRuntime,
    '@nymbalhq/web-components': {},
  }
  const subpath = '@nymbalhq/web-components/elements/'
  const elements = new Map(
    schemas.map((s) => [
      `${subpath}${s.tag}`,
      {
        [`Nymbal${s.reactName}`]: {
          define() {
            if (!customElements.get(s.tag)) customElements.define(s.tag, classes.get(s.tag)!)
          },
        },
      },
    ]),
  )
  const require = (id: string): unknown => {
    const element = elements.get(id)
    if (element !== undefined) return element
    if (!(id in modules)) throw new Error(`generated wrappers import ${id}`)
    return modules[id]
  }
  const module = { exports: {} as Record<string, Wrapper> }
  new Function('require', 'module', 'exports', outputText)(require, module, module.exports)
  return module.exports
}

function valueOf(type: AttrType): fc.Arbitrary<unknown> {
  switch (type) {
    case 'string':
      return fc.string({ maxLength: 12 })
    case 'number':
      return fc.integer({ min: 0, max: 1_000_000 })
    case 'boolean':
      return fc.boolean()
    case 'json':
      return fc.dictionary(
        fc.stringMatching(/^[a-z]{1,6}$/),
        fc.oneof(fc.string({ maxLength: 6 }), fc.integer({ min: 0, max: 99 }), fc.boolean()),
        { maxKeys: 3 },
      )
  }
}

function propsFor(attributes: readonly Attribute[]): fc.Arbitrary<Record<string, unknown>> {
  return fc.record(Object.fromEntries(attributes.map((a) => [a.prop, valueOf(a.type)])))
}

/** What the element should have seen: each prop as set, a boolean prop as present or absent. */
function expected(attributes: readonly Attribute[], props: Record<string, unknown>): Seen {
  const values = Object.fromEntries(
    attributes.map((a) => [a.prop, a.type === 'boolean' ? props[a.prop] === true : props[a.prop]]),
  )
  return { attributes: values, properties: values }
}

afterEach(cleanup)

let generation = 0

// ─── Generated schemas ──────────────────────────────────────────────────────

const lower = fc.stringMatching(/^[a-z]{2,8}$/)
const pascal = (w: string): string => w.charAt(0).toUpperCase() + w.slice(1)

// An attribute named as its prop (`qty`) or in kebab case beside a camelCase prop (`variant-id`).
const attribute: fc.Arbitrary<Attribute> = fc
  .record({
    a: lower,
    b: fc.option(lower, { nil: undefined }),
    type: fc.constantFrom<AttrType>('string', 'number', 'boolean', 'json'),
  })
  .map(({ a, b, type }) =>
    b === undefined
      ? { name: `x${a}`, prop: `x${a}`, type }
      : { name: `x${a}-${b}`, prop: `x${a}${pascal(b)}`, type },
  )

const schema: fc.Arbitrary<ElementSchema> = fc
  .record({
    word: lower,
    attributes: fc.uniqueArray(attribute, {
      minLength: 1,
      maxLength: 4,
      selector: (a) => a.prop.toLowerCase(),
    }),
    children: fc.boolean(),
  })
  .map(({ word, attributes, children }) => ({
    tag: `gen-${word}`,
    reactName: `Gen${pascal(word)}`,
    attributes,
    events: [],
    parts: [],
    slots: [],
    children,
  }))

// ─── The committed wrappers ─────────────────────────────────────────────────

const REAL: ElementSchema[] = Object.values(wc as Record<string, unknown>)
  .map((v) => (v as { schema?: ElementSchema } | null)?.schema)
  .filter((s): s is ElementSchema => s !== undefined)
  .filter((s) => s.attributes.length > 0)

// The committed wrappers define their real elements unless the tag is defined, so each tag is defined first here.
const realSeen = new Map<string, Seen[]>()
for (const s of REAL) {
  const seen: Seen[] = []
  realSeen.set(s.tag, seen)
  customElements.define(s.tag, litLike(s, seen))
}

describe('AC-1: a wrapper’s element has its attributes and properties when it first connects', () => {
  it('AC-1: property: a wrapper generated from any schema, its tag defined before or by the wrapper, connects its element with every attribute and property its props set', () => {
    fc.assert(
      fc.property(
        schema.chain((s) => fc.tuple(fc.constant(s), propsFor(s.attributes), fc.boolean())),
        ([generated, props, definedFirst]) => {
          // A tag is defined once per document, so each run (a shrink's included) gets its own.
          const s = { ...generated, tag: `${generated.tag}-${++generation}` }
          const seen: Seen[] = []
          const classes = new Map([[s.tag, litLike(s, seen)]])
          if (definedFirst) customElements.define(s.tag, classes.get(s.tag)!)
          const Wrapper = load([s], classes)[s.reactName]!
          render(<Wrapper {...props} />)
          expect(customElements.get(s.tag), `${s.tag} is defined`).toBeDefined()
          expect(seen).toEqual([expected(s.attributes, props)])
          cleanup()
        },
      ),
      { numRuns: 80 },
    )
  })

  it('AC-1: property: every committed wrapper, its tag defined first, connects its element with every attribute and property its props set', () => {
    expect(REAL.length, 'elements with attributes').toBeGreaterThan(0)
    const wrappers = committed as unknown as Record<string, Wrapper>
    for (const s of REAL) {
      const seen = realSeen.get(s.tag)!
      const Wrapper = wrappers[s.reactName]!
      fc.assert(
        fc.property(propsFor(s.attributes), (props) => {
          seen.length = 0
          render(<Wrapper {...props} />)
          expect(seen, `<${s.tag}> at its first connect`).toEqual([expected(s.attributes, props)])
          cleanup()
        }),
        { numRuns: 10 },
      )
    }
  })
})
