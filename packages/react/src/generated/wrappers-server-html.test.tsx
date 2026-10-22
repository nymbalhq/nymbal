import fc from 'fast-check'
import * as React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import { renderToString } from 'react-dom/server'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import * as wc from '@nymbalhq/web-components'
import type { ElementSchema } from '@nymbalhq/web-components'
import { generateWrappers } from '../../scripts/generate-wrappers.js'
import * as committed from './wrappers.js'

// P2-18 AC-7 (spec Decision 7): a wrapper rendered on the server carries every schema attribute on its tag, so a page
// rendered on the server (a 'use client' view included) ships the attributes its element renders from, before any
// effect runs. `renderToString` runs no effect: an attribute set only in a `useEffect` (the generator before this
// task) is missing from its output. Proved on generated schemas through the generator, and on every committed
// wrapper with its element's real schema. The P2-06 AC-2 property (attribute changes reach the element through the
// effect, generate-wrappers.test.ts) and P2-08 AC-5 (wrappers-per-element.test.ts) are unchanged and still hold.

type Attribute = ElementSchema['attributes'][number]
type AttrType = Attribute['type']
type Wrapper = React.ComponentType<Record<string, unknown>>

/** Generates the wrappers for `schemas`, compiles the TSX and evaluates it, with React as the only real import. */
function load(schemas: ElementSchema[]): Record<string, Wrapper> {
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
    schemas.map((s) => [`${subpath}${s.tag}`, { [`Nymbal${s.reactName}`]: { define() {} } }]),
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

/** The attribute the server HTML carries, read back as the prop value that set it. */
function readBack(type: AttrType, raw: string | null): unknown {
  if (type === 'boolean') return raw !== null
  if (raw === null) return undefined
  if (type === 'number') return Number(raw)
  if (type === 'json') return JSON.parse(raw) as unknown
  return raw
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

/** The element a wrapper's server HTML holds, parsed (jsdom parses no declarative shadow DOM). */
function serverElement(
  wrapper: Wrapper,
  tag: string,
  props: Record<string, unknown>,
): Element | null {
  const container = document.createElement('div')
  container.innerHTML = renderToString(React.createElement(wrapper, props))
  return container.querySelector(tag)
}

/** Each attribute of the schema as the server HTML carries it, read back, keyed by prop. */
function carried(el: Element | null, attributes: readonly Attribute[]): Record<string, unknown> {
  return Object.fromEntries(
    attributes.map((a) => [a.prop, readBack(a.type, el?.getAttribute(a.name) ?? null)]),
  )
}

const expectedOf = (attributes: readonly Attribute[], props: Record<string, unknown>) =>
  Object.fromEntries(attributes.map((a) => [a.prop, props[a.prop]]))

// ─── Generated schemas ──────────────────────────────────────────────────────

const lower = fc.stringMatching(/^[a-z]{2,8}$/)
const pascal = (w: string): string => w.charAt(0).toUpperCase() + w.slice(1)

const attribute: fc.Arbitrary<Attribute> = fc
  .record({
    a: lower,
    b: lower,
    type: fc.constantFrom<AttrType>('string', 'number', 'boolean', 'json'),
  })
  .map(({ a, b, type }) => ({ name: `x${a}-${b}`, prop: `x${a}${pascal(b)}`, type }))

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

const schemas = fc.uniqueArray(schema, { minLength: 1, maxLength: 4, selector: (s) => s.tag })

// ─── The committed wrappers ─────────────────────────────────────────────────

const REAL: ElementSchema[] = Object.values(wc as Record<string, unknown>)
  .map((v) => (v as { schema?: ElementSchema } | null)?.schema)
  .filter((s): s is ElementSchema => s !== undefined)
  .filter((s) => s.attributes.length > 0)

describe('P2-18 AC-7: wrappers carry attributes in server HTML', () => {
  it('AC-7: property: renderToString of a wrapper generated from any schema puts every attribute on its tag, read back as the prop that set it', () => {
    fc.assert(
      fc.property(
        schemas.chain((list) =>
          fc.tuple(fc.constant(list), fc.tuple(...list.map((s) => propsFor(s.attributes)))),
        ),
        ([list, values]) => {
          const mod = load(list)
          list.forEach((s, i) => {
            const props = values[i]!
            const el = serverElement(mod[s.reactName]!, s.tag, props)
            expect(el, `${s.reactName} renders <${s.tag}> on the server`).not.toBeNull()
            expect(carried(el, s.attributes)).toEqual(expectedOf(s.attributes, props))
          })
        },
      ),
      { numRuns: 60 },
    )
  })

  it('AC-7: property: renderToString of every committed wrapper with its element’s schema attributes set puts each one on the tag', () => {
    expect(REAL.length, 'elements with attributes').toBeGreaterThan(0)
    const wrappers = committed as unknown as Record<string, Wrapper>
    for (const s of REAL) {
      fc.assert(
        fc.property(propsFor(s.attributes), (props) => {
          const el = serverElement(wrappers[s.reactName]!, s.tag, props)
          expect(el, `${s.reactName} renders <${s.tag}> on the server`).not.toBeNull()
          expect(carried(el, s.attributes)).toEqual(expectedOf(s.attributes, props))
        }),
        { numRuns: 10 },
      )
    }
  })
})
