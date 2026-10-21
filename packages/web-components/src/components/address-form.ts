import { css, html } from 'lit'
import type { Address } from '@nymbalhq/types'
import { baseStyles, NymbalElement, propertiesOf, type ElementSchema } from '../base-element.js'
import { renderField, type FieldSpec } from '../form-element.js'
import { fieldStyles } from '../view-styles.js'

const SCHEMA: ElementSchema = {
  tag: 'nymbal-address-form',
  reactName: 'AddressForm',
  attributes: [{ name: 'id-prefix', prop: 'idPrefix', type: 'string' }],
  events: [],
  parts: ['fields', 'field', 'label', 'input'],
  slots: [],
  children: false,
}

type FieldName = Exclude<keyof Address, 'company' | 'phone'>

const FIELDS: Array<Omit<FieldSpec, 'id' | 'name'> & { name: FieldName; full?: boolean }> = [
  { name: 'firstName', label: 'First Name', autocomplete: 'given-name', required: true },
  { name: 'lastName', label: 'Last Name', autocomplete: 'family-name', required: true },
  {
    name: 'addressLine1',
    label: 'Address Line 1',
    autocomplete: 'address-line1',
    required: true,
    full: true,
  },
  {
    name: 'addressLine2',
    label: 'Address Line 2 (optional)',
    autocomplete: 'address-line2',
    full: true,
  },
  { name: 'city', label: 'City', autocomplete: 'address-level2', required: true },
  { name: 'region', label: 'State / County', autocomplete: 'address-level1', required: true },
  { name: 'postalCode', label: 'Postcode', autocomplete: 'postal-code', required: true },
  {
    name: 'country',
    label: 'Country (2-letter code)',
    autocomplete: 'country',
    required: true,
    placeholder: 'GB',
  },
]

/**
 * The address fields, with ids and test ids `<id-prefix>-<field>`. It renders no `<form>`: the view that holds it owns
 * the submit and reads `value`.
 */
export class NymbalAddressForm extends NymbalElement {
  static override schema = SCHEMA
  static override properties = propertiesOf(SCHEMA)
  static override styles = [
    baseStyles,
    fieldStyles,
    css`
      [part~='fields'] {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
        gap: 0 var(--nymbal-spacing-md, 1rem);
      }
      .full {
        grid-column: 1 / -1;
      }
    `,
  ]

  declare idPrefix: string | undefined

  private input(name: FieldName): HTMLInputElement | null {
    return this.renderRoot.querySelector<HTMLInputElement>(`[name="${name}"]`)
  }

  /** The address as typed, trimmed; an empty second line is left out. */
  get value(): Address {
    const field = (name: FieldName): string => this.input(name)?.value.trim() ?? ''
    const line2 = field('addressLine2')
    return {
      firstName: field('firstName'),
      lastName: field('lastName'),
      addressLine1: field('addressLine1'),
      ...(line2 !== '' && { addressLine2: line2 }),
      city: field('city'),
      region: field('region'),
      postalCode: field('postalCode'),
      country: field('country'),
    }
  }

  /** Shows the browser's message on the first field that is not valid, as a native form would. */
  reportValidity(): boolean {
    for (const input of this.renderRoot.querySelectorAll('input')) {
      if (!input.reportValidity()) return false
    }
    return true
  }

  reset(): void {
    for (const input of this.renderRoot.querySelectorAll('input')) input.value = ''
  }

  protected override render() {
    const prefix = this.idPrefix ?? 'address'
    return html`
      <div part="fields">
        ${FIELDS.map(
          ({ full, ...f }) =>
            html`<div class=${full ? 'full' : ''}>
              ${renderField({ ...f, id: `${prefix}-${f.name}` })}
            </div>`,
        )}
      </div>
    `
  }
}
