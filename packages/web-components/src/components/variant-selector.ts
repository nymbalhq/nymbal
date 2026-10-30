import '@nymbalhq/sdk/ns/product'
import { css, html } from 'lit'
import type { DenormalisedVariant, DenormalisedProduct } from '@nymbalhq/sdk'
import type { VariantOption } from '@nymbalhq/types'
import {
  baseStyles,
  NymbalElement,
  parsedJson,
  propertiesOf,
  type ElementSchema,
} from '../base-element.js'

interface OptionGroup {
  name: string
  values: string[]
}

/** A variant's options when they are the `VariantOption[]` the read model serves; any other shape offers none. */
function optionsOf(variant: DenormalisedVariant): VariantOption[] {
  return Array.isArray(variant.options) ? variant.options : []
}

function optionGroupsOf(product: DenormalisedProduct): OptionGroup[] {
  const groups = new Map<string, Set<string>>()
  for (const variant of product.variants) {
    for (const opt of optionsOf(variant)) {
      let values = groups.get(opt.name)
      if (!values) {
        values = new Set()
        groups.set(opt.name, values)
      }
      values.add(opt.value)
    }
  }
  return Array.from(groups.entries()).map(([name, values]) => ({
    name,
    values: Array.from(values),
  }))
}

const SCHEMA: ElementSchema = {
  tag: 'nymbal-variant-selector',
  reactName: 'VariantSelector',
  // The product a server read, whose options show until the product store settles.
  attributes: [{ name: 'product', prop: 'product', type: 'json' }],
  events: [
    { name: 'nymbal:variant:selected', prop: 'onVariantSelected', detail: '{ variant: unknown }' },
  ],
  parts: ['group', 'label', 'options', 'option'],
  slots: [],
  children: false,
}

export class NymbalVariantSelector extends NymbalElement {
  static override schema = SCHEMA
  static override properties = propertiesOf(SCHEMA)

  static override styles = [
    baseStyles,
    css`
      :host {
        display: block;
        font-family: var(--nymbal-font-family, system-ui, -apple-system, sans-serif);
      }
      [part~='group'] {
        margin-bottom: var(--nymbal-spacing-md, 1rem);
      }
      [part~='label'] {
        display: block;
        font-size: var(--nymbal-font-size-sm, 0.875rem);
        font-weight: var(--nymbal-font-weight-medium, 500);
        margin-bottom: var(--nymbal-spacing-sm, 0.5rem);
        color: var(--nymbal-color-text, #18181b);
      }
      [part~='options'] {
        display: flex;
        flex-wrap: wrap;
        gap: var(--nymbal-spacing-sm, 0.5rem);
      }
      [part~='option'] {
        font-family: var(--nymbal-font-family, system-ui, -apple-system, sans-serif);
        font-size: var(--nymbal-font-size-sm, 0.875rem);
        background: var(--nymbal-color-surface, #ffffff);
        color: var(--nymbal-color-text, #18181b);
        border: 1px solid var(--nymbal-color-border, #e4e4e7);
        border-radius: var(--nymbal-radius-md, 0.375rem);
        padding: var(--nymbal-spacing-xs, 0.25rem) var(--nymbal-spacing-md, 1rem);
        cursor: pointer;
        transition:
          border-color var(--nymbal-transition-fast, 150ms ease),
          background var(--nymbal-transition-fast, 150ms ease);
      }
      [part~='option']:hover {
        border-color: var(--nymbal-color-primary, #18181b);
      }
      [part~='option'][aria-pressed='true'] {
        background: var(--nymbal-color-primary, #18181b);
        color: var(--nymbal-color-text-inverse, #ffffff);
        border-color: var(--nymbal-color-primary, #18181b);
      }
      [part~='option']:disabled {
        opacity: 0.4;
        cursor: not-allowed;
      }
    `,
  ]

  declare product: unknown

  protected override stores() {
    return [this.client.product]
  }

  protected override storeSettled(): void {
    this.product = undefined
  }

  protected override render() {
    const state = this.readsStores ? this.client.product.getState() : null
    const product =
      parsedJson<DenormalisedProduct>(this, 'product', this.product) ?? state?.product ?? null
    const selected = state?.selectedVariant ?? null
    if (!product) return html``

    return optionGroupsOf(product).map(
      (group) => html`
        <div part="group">
          <span part="label">${group.name}</span>
          <div part="options">
            ${group.values.map((value) => {
              const isSelected =
                selected !== null &&
                optionsOf(selected).some((o) => o.name === group.name && o.value === value)
              return html`<button
                type="button"
                part="option"
                data-testid="variant-option-${group.name}-${value}"
                aria-pressed=${String(isSelected)}
                @click=${() => this.choose(product, group.name, value)}
              >
                ${value}
              </button>`
            })}
          </div>
        </div>
      `,
    )
  }

  private choose(product: DenormalisedProduct, optionName: string, optionValue: string): void {
    const selected = this.client.product.getState().selectedVariant
    const currentSelections = new Map<string, string>()
    if (selected) {
      for (const opt of optionsOf(selected)) currentSelections.set(opt.name, opt.value)
    }
    currentSelections.set(optionName, optionValue)

    const match = product.variants.find((v: DenormalisedVariant) =>
      optionsOf(v).every((o) => currentSelections.get(o.name) === o.value),
    )
    if (!match) return
    this.client.product.selectVariant(match)
    this.dispatchEvent(
      new CustomEvent('nymbal:variant:selected', {
        bubbles: true,
        composed: true,
        detail: { variant: match },
      }),
    )
  }
}
