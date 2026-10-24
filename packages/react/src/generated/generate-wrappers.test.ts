import fc from 'fast-check'
import * as React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import { cleanup, render } from '@testing-library/react'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import * as wc from '@nymbalhq/web-components'
import type { ElementSchema } from '@nymbalhq/web-components'
import { generateWrappers } from '../../scripts/generate-wrappers.js'

// AC-2: the React wrappers come from the schema each element declares. `generateWrappers` is run over generated
// schemas and its output is compiled and rendered: every attribute is a prop that sets that attribute, every event an
// `on…` prop that receives it. Adding an attribute to a copy of a real element's schema adds exactly that one prop to
// that wrapper and leaves every other wrapper rendering the same attributes. (The real schemas against the committed
// wrappers.tsx is `check:generated`, in tests/tooling/wrappers-check.test.ts.)

type Attribute = ElementSchema['attributes'][number]
type EventDef = ElementSchema['events'][number]
type AttrType = 'string' | 'number' | 'boolean' | 'json'
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
    // The elements themselves are not under test here: the wrapper's tag stays a plain element.
    '@nymbalhq/web-components': {},
  }
  // Each wrapper imports its element's class from the element's own subpath. The element is not under test here, so
  // its class is a stub whose define() does nothing and the tag stays a plain element.
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

/** The attribute the element carries, read back as the prop value that set it. */
function readBack(type: string, raw: string | null): unknown {
  if (type === 'boolean') return raw !== null
  if (raw === null) return undefined
  if (type === 'number') return Number(raw)
  if (type === 'json') return JSON.parse(raw) as unknown
  return raw
}

function valueOf(type: string): fc.Arbitrary<unknown> {
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
    default:
      throw new Error(`no value for attribute type ${type}`)
  }
}

function propsFor(attributes: readonly Attribute[]): fc.Arbitrary<Record<string, unknown>> {
  return fc.record(Object.fromEntries(attributes.map((a) => [a.prop, valueOf(a.type)])))
}

/** The element a wrapper renders with `props`, as its attributes, name to value, sorted. */
function attributesOf(
  wrapper: Wrapper | undefined,
  tag: string,
  props: Record<string, unknown>,
): Array<[string, string]> {
  if (wrapper === undefined) throw new Error(`no wrapper for ${tag}`)
  const { container } = render(React.createElement(wrapper, props))
  const el = container.querySelector(tag)
  const attrs =
    el === null ? [] : [...el.attributes].map((a): [string, string] => [a.name, a.value])
  cleanup()
  return attrs.sort(([a], [b]) => a.localeCompare(b))
}

function parse(source: string): ts.SourceFile {
  return ts.createSourceFile(
    'wrappers.tsx',
    source,
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TSX,
  )
}

/**
 * A generated module cut at what belongs to `schema`: its element import, its intrinsic element entry, its props
 * types and its component. `rest` holds the text around those pieces, so `rest.length === own.length + 1`.
 */
function split(sf: ts.SourceFile, schema: ElementSchema): { own: string[]; rest: string[] } {
  const source = sf.text
  const names = new Set([
    schema.reactName,
    `${schema.reactName}Props`,
    `${schema.reactName}OwnProps`,
    schema.tag,
  ])
  const spans: Array<[number, number]> = []
  const visit = (node: ts.Node): void => {
    const name = (node as { name?: ts.Node }).name
    const owned =
      (ts.isImportDeclaration(node) &&
        ts.isStringLiteral(node.moduleSpecifier) &&
        node.moduleSpecifier.text === `@nymbalhq/web-components/elements/${schema.tag}`) ||
      (name !== undefined &&
        (ts.isIdentifier(name) || ts.isStringLiteral(name)) &&
        names.has(name.text))
    if (owned) spans.push([node.getStart(sf), node.end])
    else ts.forEachChild(node, visit)
  }
  visit(sf)
  const own: string[] = []
  const rest: string[] = []
  let at = 0
  for (const [start, end] of spans) {
    rest.push(source.slice(at, start))
    own.push(source.slice(start, end))
    at = end
  }
  rest.push(source.slice(at))
  return { own, rest }
}

// ─── Generated schemas ──────────────────────────────────────────────────────

const lower = fc.stringMatching(/^[a-z]{2,8}$/)
const pascal = (w: string): string => w.charAt(0).toUpperCase() + w.slice(1)

const attributeOf = (type: fc.Arbitrary<AttrType>): fc.Arbitrary<Attribute> =>
  fc
    .record({ a: lower, b: lower, type })
    .map(({ a, b, type: t }) => ({ name: `x${a}-${b}`, prop: `x${a}${pascal(b)}`, type: t }))

const anyType = fc.constantFrom<AttrType>('string', 'number', 'boolean', 'json')

const event = fc.record({ a: lower, b: lower }).map(({ a, b }) => ({
  name: `nymbal:${a}:${b}`,
  prop: `on${pascal(a)}${pascal(b)}`,
  detail: '{ value: string }',
}))

const schema: fc.Arbitrary<ElementSchema> = fc
  .record({
    word: lower,
    attributes: fc.uniqueArray(attributeOf(anyType), {
      maxLength: 4,
      selector: (a) => a.prop.toLowerCase(),
    }),
    events: fc.uniqueArray(event, { maxLength: 3, selector: (e) => e.prop.toLowerCase() }),
    children: fc.boolean(),
  })
  .map(({ word, attributes, events, children }) => ({
    tag: `gen-${word}`,
    reactName: `Gen${pascal(word)}`,
    attributes,
    events,
    parts: [],
    slots: [],
    children,
  }))

const schemas = fc.uniqueArray(schema, { minLength: 1, maxLength: 4, selector: (s) => s.tag })

const realSchemas: ElementSchema[] = Object.values(wc)
  .map((v) => (v as { schema?: ElementSchema }).schema)
  .filter((s): s is ElementSchema => s !== undefined)

describe('AC-2: wrappers are generated from the element schemas', () => {
  it('AC-2: property: every attribute of a generated schema is a prop that sets that attribute, and every event an on… prop that receives it', () => {
    fc.assert(
      fc.property(
        schemas.chain((list) =>
          fc.tuple(
            fc.constant(list),
            fc.tuple(...list.map((s) => propsFor(s.attributes))),
            fc.string({ maxLength: 8 }),
          ),
        ),
        ([list, values, detail]) => {
          const mod = load(list)
          list.forEach((s, i) => {
            const wrapper = mod[s.reactName]
            expect(wrapper, `${s.reactName} is exported`).toBeDefined()
            const handlers = Object.fromEntries(s.events.map((e: EventDef) => [e.prop, vi.fn()]))
            const props = { ...values[i], ...handlers }
            const { container } = render(React.createElement(wrapper!, props))
            const el = container.querySelector(s.tag)
            expect(el, `${s.reactName} renders <${s.tag}>`).not.toBeNull()
            for (const a of s.attributes) {
              expect(
                readBack(a.type, el!.getAttribute(a.name)),
                `${a.prop} sets ${a.name}`,
              ).toEqual(props[a.prop])
            }
            for (const e of s.events) {
              el!.dispatchEvent(new CustomEvent(e.name, { detail: { value: detail } }))
              const handler = handlers[e.prop]!
              expect(handler, `${e.prop} receives ${e.name}`).toHaveBeenCalledTimes(1)
              expect((handler.mock.calls[0]![0] as CustomEvent).detail).toEqual({ value: detail })
            }
            cleanup()
          })
        },
      ),
      { numRuns: 60 },
    )
  })

  it('AC-2: property: adding an attribute to a copy of a real element’s schema adds exactly that one prop to its wrapper and changes no other wrapper', () => {
    expect(realSchemas.length, 'the package exports its element schemas').toBeGreaterThan(0)
    const before = load(realSchemas)
    const beforeFile = parse(generateWrappers(realSchemas))
    const around = new Map<number, string[]>()
    const aroundOf = (index: number): string[] => {
      if (!around.has(index)) around.set(index, split(beforeFile, realSchemas[index]!).rest)
      return around.get(index)!
    }
    fc.assert(
      fc.property(
        fc
          .record({
            index: fc.nat({ max: realSchemas.length - 1 }),
            added: attributeOf(anyType),
          })
          .chain(({ index, added }) =>
            fc.record({
              index: fc.constant(index),
              added: fc.constant(added),
              addedValue: valueOf(added.type).filter((v) => v !== false),
              values: propsFor(realSchemas[index]!.attributes),
            }),
          ),
        ({ index, added, addedValue, values }) => {
          const changed = realSchemas.map((s, i) =>
            i === index ? { ...s, attributes: [...s.attributes, added] } : s,
          )
          // The module is the one before with only the changed element's pieces replaced, by the pieces its own module
          // has: every other wrapper's source, and so its code, is unchanged byte for byte. Only that one module is
          // compiled, so a run costs the same however many elements the package has.
          const target = changed[index]!
          const rest = aroundOf(index)
          const { own } = split(parse(generateWrappers([target])), target)
          expect(own.length, `${target.reactName}'s pieces`).toBe(rest.length - 1)
          expect(generateWrappers(changed)).toBe(
            rest.map((text, i) => text + (own[i] ?? '')).join(''),
          )
          const after = load([target])
          // The changed one renders what it did, plus the one attribute the new prop sets.
          const was = attributesOf(before[target.reactName], target.tag, values)
          const now = attributesOf(after[target.reactName], target.tag, {
            ...values,
            [added.prop]: addedValue,
          })
          expect(was.map(([n]) => n)).not.toContain(added.name)
          expect(
            now.filter(([n]) => n !== added.name),
            target.reactName,
          ).toEqual(was)
          expect(now.length, `${target.reactName} gains exactly one attribute`).toBe(was.length + 1)
          const raw = now.find(([n]) => n === added.name)?.[1] ?? null
          expect(readBack(added.type, raw), `${added.prop} sets ${added.name}`).toEqual(addedValue)
        },
      ),
      { numRuns: 30 },
    )
  })
})
