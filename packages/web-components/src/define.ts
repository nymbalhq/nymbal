import type { ElementSchema } from './base-element.js'

/** A Nymbal element class, as `define` takes it. */
export interface NymbalElementClass extends CustomElementConstructor {
  schema: ElementSchema
  /** The Nymbal elements it renders in its own shadow root, which must be defined for it to work. */
  uses?: readonly NymbalElementClass[]
  /** What the element needs registered before it runs; called whether or not its tag is still free. */
  beforeDefine?(): void
}

/**
 * Defines each element under its schema's tag, with the elements it renders, except a tag that is already defined:
 * an element the project defined first under a Nymbal tag wins.
 */
export function define(...elements: NymbalElementClass[]): void {
  for (const element of elements) {
    element.beforeDefine?.()
    if (element.uses !== undefined) define(...element.uses)
    if (!customElements.get(element.schema.tag)) {
      customElements.define(element.schema.tag, element)
    }
  }
}
