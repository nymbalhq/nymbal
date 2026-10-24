import { html, LitElement } from 'lit'
import { describe, expect, it } from 'vitest'
import { NymbalMiniCart, NymbalToast, type NymbalElementClass } from '../index.js'
import { registerServerElements, renderElement } from './index.js'

// AC-3, the unit half: a project registers its own class under a Nymbal tag, and the server renders that class's
// template under the tag and none of the package element's parts, whether or not the package element was rendered
// under it before (Lit SSR defines once per process, so the class is resolved per call). A second registration of a
// different class under one tag is refused.

/** A project's element, as its elements entry would declare it. */
function projectElement(tag: string, marker: string): NymbalElementClass {
  class ProjectElement extends LitElement {
    static schema = {
      tag,
      reactName: 'Project',
      attributes: [],
      events: [],
      parts: [marker],
      slots: [],
      children: false,
    }

    override render() {
      return html`<span part=${marker}>project</span>`
    }
  }
  return ProjectElement as unknown as NymbalElementClass
}

/** The part names the server's declarative shadow root holds, in document order. */
function serverParts(out: string): string[] {
  const parsed = document.createElement('template')
  parsed.innerHTML = out
  // The host's first child, found without `:scope`, which happy-dom's selector engine never matches.
  const shadow = parsed.content.firstElementChild?.firstElementChild
  if (shadow?.localName !== 'template' || shadow.getAttribute('shadowrootmode') !== 'open')
    throw new Error(`no declarative shadow root in ${out}`)
  return [...(shadow as HTMLTemplateElement).content.querySelectorAll('[part]')].flatMap((n) =>
    (n.getAttribute('part') ?? '').split(/\s+/).filter((p) => p !== ''),
  )
}

const packageParts = (parts: string[], element: NymbalElementClass): string[] =>
  parts.filter((p) => element.schema.parts.includes(p))

describe('AC-3: the server honours the project’s elements entry', () => {
  it('AC-3: after registerServerElements({ "nymbal-mini-cart": ProjectMiniCart }), renderElement("nymbal-mini-cart") renders the project’s marker part and none of the package’s, though the package mini-cart rendered under the tag first', () => {
    const before = serverParts(renderElement('nymbal-mini-cart'))
    expect(packageParts(before, NymbalMiniCart).length).toBeGreaterThan(0)

    registerServerElements({
      'nymbal-mini-cart': projectElement('nymbal-mini-cart', 'project-marker'),
    })
    const after = serverParts(renderElement('nymbal-mini-cart'))

    expect(after).toContain('project-marker')
    expect(packageParts(after, NymbalMiniCart)).toEqual([])
  })

  it('AC-3: a second registration of a different class under a tag is refused, the same class again is not, and the first stays the one rendered', () => {
    const first = projectElement('nymbal-toast', 'first-marker')
    const second = projectElement('nymbal-toast', 'second-marker')
    registerServerElements({ 'nymbal-toast': first })

    expect(() => registerServerElements({ 'nymbal-toast': first })).not.toThrow()
    expect(() => registerServerElements({ 'nymbal-toast': second })).toThrow()

    const parts = serverParts(renderElement('nymbal-toast'))
    expect(parts).toContain('first-marker')
    expect(parts).not.toContain('second-marker')
    expect(packageParts(parts, NymbalToast).length).toBe(0)
  })
})
