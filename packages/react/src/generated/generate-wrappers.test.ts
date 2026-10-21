import fc from 'fast-check'
import * as React from 'react'
import * as jsxRuntime from 'react/jsx-runtime'
import { cleanup, render } from '@testing-library/react'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import * as wc from '@nymbalhq/web-components'
import type { ElementSchema } from '@nymbalhq/web-components'
import { generateWrappers } from '../../scripts/generate-wrappers.js'

// P2-06 AC-2: the React wrappers come from the schema each element declares. `generateWrappers` is run over generated
// schemas and its output is compiled and rendered: every attribute is a prop that sets that attribute, every event an
// `on…` prop that receives it. Adding an attribute to a copy of a real element's schema adds exactly that one prop to
// that wrapper and leaves every other wrapper rendering the same attributes. (The real schemas against the committed
// wrappers.tsx is `check:generated`, in tests/tooling/wrappers-check.test.ts.)

type Attribute = ElementSchema['attributes'][number]
type EventDef = ElementSchema['events'][number]
type AttrType = 'string' | 'number' | 'boolean' | 'json'
type Wrapper = React.ComponentType<Record<string, unknown>>

/** Compiles generated TSX and evaluates it, with React as the only real import. */
function load(source: string): Record<string, Wrapper> {
  const { outputText } = ts.transpileModule(source, {
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
  const require = (id: string): unknown => {
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
  const attrs = el === null ? [] : [...el.attributes].map((a): [string, string] => [a.name, a.value])
  cleanup()
  return attrs.sort(([a], [b]) => a.localeCompare(b))
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

describe('P2-06 AC-2: wrappers are generated from the element schemas', () => {
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
          const mod = load(generateWrappers(list))
          list.forEach((s, i) => {
            const wrapper = mod[s.reactName]
            expect(wrapper, `${s.reactName} is exported`).toBeDefined()
            const handlers = Object.fromEntries(s.events.map((e: EventDef) => [e.prop, vi.fn()]))
            const props = { ...values[i], ...handlers }
            const { container } = render(React.createElement(wrapper!, props))
            const el = container.querySelector(s.tag)
            expect(el, `${s.reactName} renders <${s.tag}>`).not.toBeNull()
            for (const a of s.attributes) {
              expect(readBack(a.type, el!.getAttribute(a.name)), `${a.prop} sets ${a.name}`).toEqual(
                props[a.prop],
              )
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
    const before = load(generateWrappers(realSchemas))
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
              values: fc.tuple(...realSchemas.map((s) => propsFor(s.attributes))),
            }),
          ),
        ({ index, added, addedValue, values }) => {
          const changed = realSchemas.map((s, i) =>
            i === index ? { ...s, attributes: [...s.attributes, added] } : s,
          )
          const after = load(generateWrappers(changed))
          expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort())
          // Every other wrapper renders the same attributes from the same props.
          realSchemas.forEach((s, i) => {
            const others = i === index ? [] : [values[i]!]
            for (const props of others) {
              expect(attributesOf(after[s.reactName], s.tag, props), s.reactName).toEqual(
                attributesOf(before[s.reactName], s.tag, props),
              )
            }
          })
          // The changed one renders what it did, plus the one attribute the new prop sets.
          const target = realSchemas[index]!
          const was = attributesOf(before[target.reactName], target.tag, values[index]!)
          const now = attributesOf(after[target.reactName], target.tag, {
            ...values[index]!,
            [added.prop]: addedValue,
          })
          expect(was.map(([n]) => n)).not.toContain(added.name)
          expect(now.filter(([n]) => n !== added.name), target.reactName).toEqual(was)
          expect(now.length, `${target.reactName} gains exactly one attribute`).toBe(was.length + 1)
          const raw = now.find(([n]) => n === added.name)?.[1] ?? null
          expect(readBack(added.type, raw), `${added.prop} sets ${added.name}`).toEqual(addedValue)
        },
      ),
      { numRuns: 30 },
    )
  })
})
