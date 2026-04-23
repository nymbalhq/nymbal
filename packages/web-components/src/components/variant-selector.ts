import type { DenormalisedVariant, DenormalisedProduct } from '@nymbal/sdk'
import type { VariantOption } from '@nymbal/types'
import { NymbalElement } from '../base-element.js'
import { injectStyles } from '../styles.js'

const STYLES = `
nymbal-variant-selector {
  display: block;
  font-family: var(--nymbal-font-family);
}
nymbal-variant-selector .nymbal-option-group {
  margin-bottom: var(--nymbal-spacing-md);
}
nymbal-variant-selector .nymbal-option-label {
  display: block;
  font-size: var(--nymbal-font-size-sm);
  font-weight: var(--nymbal-font-weight-medium);
  margin-bottom: var(--nymbal-spacing-sm);
  color: var(--nymbal-color-text);
}
nymbal-variant-selector .nymbal-option-buttons {
  display: flex;
  flex-wrap: wrap;
  gap: var(--nymbal-spacing-sm);
}
nymbal-variant-selector .nymbal-option-btn {
  font-family: var(--nymbal-font-family);
  font-size: var(--nymbal-font-size-sm);
  background: var(--nymbal-color-surface);
  color: var(--nymbal-color-text);
  border: 1px solid var(--nymbal-color-border);
  border-radius: var(--nymbal-radius-md);
  padding: var(--nymbal-spacing-xs) var(--nymbal-spacing-md);
  cursor: pointer;
  transition: border-color var(--nymbal-transition-fast), background var(--nymbal-transition-fast);
}
nymbal-variant-selector .nymbal-option-btn:hover {
  border-color: var(--nymbal-color-primary);
}
nymbal-variant-selector .nymbal-option-btn[aria-pressed="true"] {
  background: var(--nymbal-color-primary);
  color: var(--nymbal-color-text-inverse);
  border-color: var(--nymbal-color-primary);
}
nymbal-variant-selector .nymbal-option-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
`

interface OptionGroup {
  name: string
  values: string[]
}

export class NymbalVariantSelector extends NymbalElement {
  static get observedAttributes(): string[] {
    return ['options']
  }

  protected setup(): void {
    injectStyles('nymbal-variant-selector', STYLES)
    this.subscribeToStore(this.client.product)
  }

  protected render(): void {
    const state = this.client.product.getState()
    const product = state.product
    if (!product) {
      this.innerHTML = ''
      return
    }

    const optionGroups = this.getOptionGroups(product)
    const selected = state.selectedVariant

    this.innerHTML = optionGroups.map((group) => `
      <div class="nymbal-option-group">
        <span class="nymbal-option-label">${this.esc(group.name)}</span>
        <div class="nymbal-option-buttons">
          ${group.values.map((value) => {
            const isSelected = selected?.options.some(
              (o: VariantOption) => o.name === group.name && o.value === value,
            ) ?? false
            return `<button
              class="nymbal-option-btn"
              data-testid="variant-option-${this.esc(group.name)}-${this.esc(value)}"
              data-option-name="${this.esc(group.name)}"
              data-option-value="${this.esc(value)}"
              aria-pressed="${isSelected}"
            >${this.esc(value)}</button>`
          }).join('')}
        </div>
      </div>
    `).join('')

    this.querySelectorAll('.nymbal-option-btn').forEach((btn) => {
      btn.addEventListener('click', () => {
        const el = btn as HTMLElement
        const optionName = el.dataset['optionName']
        const optionValue = el.dataset['optionValue']
        if (!optionName || !optionValue || !product) return

        const currentSelections = new Map<string, string>()
        if (selected) {
          for (const opt of selected.options as VariantOption[]) {
            currentSelections.set(opt.name, opt.value)
          }
        }
        currentSelections.set(optionName, optionValue)

        const match = product.variants.find((v: DenormalisedVariant) =>
          (v.options as VariantOption[]).every(
            (o) => currentSelections.get(o.name) === o.value,
          ),
        )

        if (match) {
          this.client.product.selectVariant(match)
          this.dispatchEvent(
            new CustomEvent('nymbal:variant:selected', {
              bubbles: true,
              composed: true,
              detail: { variant: match },
            }),
          )
        }
      })
    })
  }

  attributeChangedCallback(): void {
    if (this.isConnected) this.requestRender()
  }

  private getOptionGroups(product: DenormalisedProduct): OptionGroup[] {
    const optionsAttr = this.getAttribute('options')
    if (optionsAttr) {
      try {
        return JSON.parse(optionsAttr) as OptionGroup[]
      } catch {
        // fall through to derive from variants
      }
    }

    const groups = new Map<string, Set<string>>()
    for (const variant of product.variants) {
      for (const opt of variant.options as VariantOption[]) {
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

  private esc(str: string): string {
    const div = document.createElement('div')
    div.textContent = str
    return div.innerHTML
  }
}
