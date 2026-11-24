import { css, html, type TemplateResult } from 'lit'
import type { Address } from '@nymbalhq/types'
import { COUNTRY_CODES } from '@nymbalhq/types/countries'
import { US_STATES } from '@nymbalhq/types/us-states'
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
  { name: 'country', label: 'Country', autocomplete: 'country', required: true },
  { name: 'region', label: 'State / County', autocomplete: 'address-level1', required: true },
  { name: 'postalCode', label: 'Postcode', autocomplete: 'postal-code', required: true },
]

type Options = ReadonlyArray<{ value: string; text: string }>

interface SelectSpec {
  id: string
  name: string
  label: string
  autocomplete: string
  required?: boolean
  /** The first option's text: the empty choice the select starts on, so `required` holds until one is picked. */
  prompt: string
  options: Options
  /** Called on `input` and on `change`, as browsers differ in which a choice fires. */
  onChange?: (event: Event) => void
}

/** A labelled select; the label's `for` and the select share the element's shadow root. */
function renderSelect(f: SelectSpec): TemplateResult {
  return html`
    <div part="field">
      <label part="label" for=${f.id}>${f.label}</label>
      <select
        part="input"
        id=${f.id}
        name=${f.name}
        autocomplete=${f.autocomplete}
        ?required=${f.required ?? false}
        data-testid=${f.id}
        @input=${f.onChange}
        @change=${f.onChange}
      >
        <option value="">${f.prompt}</option>
        ${f.options.map((o) => html`<option value=${o.value}>${o.text}</option>`)}
      </select>
    </div>
  `
}

const byText = (a: Options[number], b: Options[number]): number =>
  a.text.localeCompare(b.text, 'en')

let countryOptions: Options | undefined
let stateOptions: Options | undefined

/** Every country by its English name, worked out on the first render rather than when the module loads. */
function countries(): Options {
  if (countryOptions === undefined) {
    const names = new Intl.DisplayNames(['en'], { type: 'region' })
    countryOptions = COUNTRY_CODES.map((code) => ({
      value: code,
      text: names.of(code) ?? code,
    })).sort(byText)
  }
  return countryOptions
}

function states(): Options {
  stateOptions ??= Object.entries(US_STATES)
    .map(([value, text]) => ({ value, text }))
    .sort(byText)
  return stateOptions
}

/**
 * The address fields, with ids and test ids `<id-prefix>-<field>`. It renders no `<form>`: the view that holds it owns
 * the submit (Enter in a field submits it) and reads `value`.
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

  /** The chosen country, which decides whether the region is the US state select or typed. */
  private country = ''

  private control(name: FieldName): HTMLInputElement | HTMLSelectElement | null {
    return this.renderRoot.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${name}"]`)
  }

  private controls(): NodeListOf<HTMLInputElement | HTMLSelectElement> {
    return this.renderRoot.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select')
  }

  private readonly onCountry = (event: Event): void => {
    const chosen = (event.target as HTMLSelectElement).value
    if (chosen === this.country) return
    this.country = chosen
    this.requestUpdate()
  }

  /** The address as entered, trimmed; an empty second line is left out. */
  get value(): Address {
    const field = (name: FieldName): string => this.control(name)?.value.trim() ?? ''
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
    for (const control of this.controls()) {
      if (!control.reportValidity()) return false
    }
    return true
  }

  reset(): void {
    for (const control of this.controls()) control.value = ''
    this.country = ''
    this.requestUpdate()
  }

  /**
   * The inputs sit in this shadow root, so they have no form owner and Enter in one submits nothing natively. Enter
   * submits the form that holds this element instead, as it would if the fields were its own. Enter in a select
   * submits nothing, as in a native form.
   */
  private readonly onKeydown = (event: KeyboardEvent): void => {
    if (event.key !== 'Enter' || event.isComposing || event.defaultPrevented) return
    if (!(event.target instanceof HTMLInputElement)) return
    const form = this.closest('form')
    if (form === null) return
    event.preventDefault()
    form.requestSubmit()
  }

  protected override render() {
    const prefix = this.idPrefix ?? 'address'
    return html`
      <div part="fields" @keydown=${this.onKeydown}>
        ${FIELDS.map(
          ({ full, ...f }) =>
            html`<div class=${full ? 'full' : ''}>
              ${this.renderControl({ ...f, id: `${prefix}-${f.name}` })}
            </div>`,
        )}
      </div>
    `
  }

  /**
   * The country select, the region (a state select in the US, typed elsewhere), or a text field. Moving to or from
   * the US swaps the region's control, which empties it; between two other countries the typed region stays.
   */
  private renderControl(f: Omit<FieldSpec, 'name'> & { name: FieldName }) {
    if (f.name === 'country') {
      return renderSelect({
        ...f,
        prompt: 'Select a country',
        options: countries(),
        onChange: this.onCountry,
      })
    }
    if (f.name === 'region' && this.country === 'US') {
      return renderSelect({ ...f, label: 'State', prompt: 'Select a state', options: states() })
    }
    return renderField(f)
  }
}
