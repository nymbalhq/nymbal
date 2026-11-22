import fc from 'fast-check'
import * as types from '@nymbalhq/types'
import type { Address } from '@nymbalhq/types'
import { describe, expect, it } from 'vitest'

// `nymbal-address-form`: the shopper picks the country from a list and, in the United States, the state from a list,
// so the address carries the codes the tax and shipping tables match on. Other countries keep a typed region. The
// element sits in a `<form>` here, as it does in the checkout and the address book, so Enter reaches that form.

const TAG = 'nymbal-address-form'
const PREFIX = 'ship'

type AddressForm = HTMLElement & {
  value: Address
  reportValidity(): boolean
  reset(): void
  updateComplete: Promise<boolean>
}

const TEXT_FIELDS = [
  'firstName',
  'lastName',
  'addressLine1',
  'addressLine2',
  'city',
  'postalCode',
] as const

const TYPED = {
  firstName: 'Ada',
  lastName: 'Lovelace',
  addressLine1: '1 Analytical Row',
  addressLine2: 'Flat 2',
  city: 'London',
  postalCode: 'E1 6AN',
} as const

const english = new Intl.DisplayNames(['en'], { type: 'region' })
const byName = (a: string, b: string): number => a.localeCompare(b, 'en')

function countryCodes(): readonly string[] {
  const codes = (types as unknown as { COUNTRY_CODES?: readonly string[] }).COUNTRY_CODES
  expect(codes, '@nymbalhq/types exports COUNTRY_CODES').toBeInstanceOf(Array)
  return codes!
}

/** The state codes in the order the select lists them: by name. */
function stateCodes(): string[] {
  const states = (types as unknown as { US_STATES?: Readonly<Record<string, string>> }).US_STATES
  expect(states, '@nymbalhq/types exports US_STATES').toBeInstanceOf(Object)
  return Object.entries(states!)
    .sort(([, a], [, b]) => byName(a, b))
    .map(([code]) => code)
}

function stateName(code: string): string {
  return (types as unknown as { US_STATES: Readonly<Record<string, string>> }).US_STATES[code]!
}

async function settled(el: AddressForm): Promise<void> {
  while (!(await el.updateComplete));
}

async function mount(): Promise<{ el: AddressForm; submits: () => number }> {
  expect(customElements.get(TAG), `${TAG} is defined by registerComponents()`).toBeDefined()
  document.body.innerHTML = ''
  const form = document.createElement('form')
  let submits = 0
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    submits += 1
  })
  const el = document.createElement(TAG) as AddressForm
  el.setAttribute('id-prefix', PREFIX)
  form.append(el)
  document.body.append(form)
  await settled(el)
  return { el, submits: () => submits }
}

function control(el: AddressForm, field: string): HTMLInputElement | HTMLSelectElement {
  const found = el.shadowRoot?.querySelector<HTMLInputElement | HTMLSelectElement>(
    `[data-testid="${PREFIX}-${field}"]`,
  )
  if (!found) throw new Error(`no [data-testid="${PREFIX}-${field}"] in ${TAG}`)
  return found
}

function labelOf(el: AddressForm, target: Element): string {
  return el.shadowRoot?.querySelector(`label[for="${target.id}"]`)?.textContent?.trim() ?? ''
}

/** A shopper's choice or typing: the value set, then the events a browser fires for it. */
async function enter(el: AddressForm, field: string, value: string): Promise<void> {
  const target = control(el, field)
  target.value = value
  target.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
  target.dispatchEvent(new Event('change', { bubbles: true, composed: true }))
  await settled(el)
}

async function typeAll(el: AddressForm): Promise<void> {
  for (const field of TEXT_FIELDS) await enter(el, field, TYPED[field])
}

function options(select: HTMLSelectElement): Array<{ value: string; text: string }> {
  return [...select.options].map((o) => ({ value: o.value, text: o.textContent?.trim() ?? '' }))
}

/** What the region control is: its tag, attributes and label, and for a select its options. */
function regionShape(el: AddressForm) {
  const region = control(el, 'region')
  return {
    tag: region.tagName,
    name: region.getAttribute('name'),
    type: region instanceof HTMLInputElement ? region.type : null,
    autocomplete: region.getAttribute('autocomplete'),
    required: region.required,
    id: region.id,
    label: labelOf(el, region),
    options: region instanceof HTMLSelectElement ? options(region) : null,
  }
}

function enterKey(): KeyboardEvent {
  return new KeyboardEvent('keydown', {
    key: 'Enter',
    bubbles: true,
    composed: true,
    cancelable: true,
  })
}

describe('nymbal-address-form: the country', () => {
  // Kills: the country left free text; an option whose value is a name; a label not associated, so a screen reader
  // reads no name; an unsorted list; a country chosen for the shopper; region asked before the country.
  it('AC-2: the country control is a required select named country, labelled "Country", starting on "", listing "" then every COUNTRY_CODES entry by its English name in name order, before the region control', async () => {
    const { el } = await mount()
    const country = control(el, 'country')

    expect(country.tagName).toBe('SELECT')
    const select = country as HTMLSelectElement
    expect({
      name: select.name,
      autocomplete: select.getAttribute('autocomplete'),
      required: select.required,
      part: select.getAttribute('part'),
      id: select.id,
      label: labelOf(el, select),
      value: select.value,
    }).toEqual({
      name: 'country',
      autocomplete: 'country',
      required: true,
      part: 'input',
      id: `${PREFIX}-country`,
      label: 'Country',
      value: '',
    })

    const listed = options(select)
    expect(listed[0]).toEqual({ value: '', text: 'Select a country' })
    const countries = listed.slice(1)
    expect(countries.map((o) => o.value).sort()).toEqual([...countryCodes()].sort())
    for (const option of countries) expect(option.text, option.value).toBe(english.of(option.value))
    const names = countries.map((o) => o.text)
    expect(names).toEqual([...names].sort(byName))

    expect(
      select.compareDocumentPosition(control(el, 'region')) & Node.DOCUMENT_POSITION_FOLLOWING,
      'country precedes region',
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
  })
})

/** The region control with US chosen: a "State" select of "" then the states by name. */
function stateSelect(states: string[]) {
  return {
    tag: 'SELECT',
    name: 'region',
    type: null,
    autocomplete: 'address-level1',
    required: true,
    id: `${PREFIX}-region`,
    label: 'State',
    options: [
      { value: '', text: 'Select a state' },
      ...states.map((code) => ({ value: code, text: stateName(code) })),
    ],
  }
}

/** The region control with any other country: the typed "State / County". */
const countyInput = {
  tag: 'INPUT',
  name: 'region',
  type: 'text',
  autocomplete: 'address-level1',
  required: true,
  id: `${PREFIX}-region`,
  label: 'State / County',
  options: null,
}

type Act = { kind: 'country'; code: string } | { kind: 'region'; pick: number; text: string }

const arbAct: fc.Arbitrary<Act> = fc.oneof(
  fc.record({
    kind: fc.constant('country' as const),
    code: fc.oneof(
      { arbitrary: fc.constant('US'), weight: 2 },
      { arbitrary: fc.constantFrom('GB', 'FR', 'CA', 'DE', 'IE', 'AU', 'MX'), weight: 3 },
    ),
  }),
  fc.record({
    kind: fc.constant('region' as const),
    pick: fc.nat(),
    text: fc.stringMatching(/^ {0,2}[A-Z][a-z]{2,9}( [A-Z][a-z]{2,9})? {0,2}$/),
  }),
)

describe('nymbal-address-form: the region', () => {
  // Kills: the state select shown for another country, a typed "Greater London" surviving into a US address, or
  // `value` reading a control that is no longer shown.
  it('AC-3: property: for any sequence of country choices and region entries, the region is a "State" select of the US states in name order exactly when the country is US, else a "State / County" text input; it empties when the country moves to or from US and keeps its text between two others; value holds the chosen codes, or the trimmed text', async () => {
    const states = stateCodes()
    await fc.assert(
      fc.asyncProperty(fc.array(arbAct, { minLength: 1, maxLength: 8 }), async (acts) => {
        const { el } = await mount()
        await typeAll(el)
        let country = ''
        let region = ''

        for (const act of acts) {
          if (act.kind === 'country') {
            if ((country === 'US') !== (act.code === 'US')) region = ''
            country = act.code
            await enter(el, 'country', act.code)
          } else if (country === 'US') {
            region = states[act.pick % states.length]!
            await enter(el, 'region', region)
          } else {
            region = act.text.trim()
            await enter(el, 'region', act.text)
          }

          expect(regionShape(el), JSON.stringify(acts)).toEqual(
            country === 'US' ? stateSelect(states) : countyInput,
          )
          expect(el.value, JSON.stringify(acts)).toEqual({ ...TYPED, region, country })
        }
      }),
      { numRuns: 30 },
    )
  })
})

describe('nymbal-address-form: validity, reset and Enter', () => {
  // Kills: an address with no country, or a US address with no state, reaching the quote.
  it('AC-4: property: reportValidity is false and reports the country when none is chosen, false and reports the state when US has none, and true once filled', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('', 'US', 'GB', 'FR'),
        fc.boolean(),
        async (country, stateChosen) => {
          const { el } = await mount()
          await typeAll(el)
          if (country !== '') await enter(el, 'country', country)
          if (country !== 'US') await enter(el, 'region', 'Greater London')
          else if (stateChosen) await enter(el, 'region', 'CA')

          const reported: string[] = []
          for (const c of el.shadowRoot!.querySelectorAll('input, select')) {
            c.addEventListener('invalid', () =>
              reported.push(`${c.tagName.toLowerCase()} ${c.getAttribute('name') ?? ''}`),
            )
          }
          const valid = el.reportValidity()

          const expected =
            country === ''
              ? [false, ['select country']]
              : country === 'US' && !stateChosen
                ? [false, ['select region']]
                : [true, []]
          expect([valid, [...new Set(reported)]]).toEqual(expected)
        },
      ),
      { numRuns: 16 },
    )
  })

  // Kills: a reset that leaves the last state select behind, or the last country chosen.
  it('AC-4: reset() after a US address with a state leaves every field empty, the country on "" and the region an empty text input', async () => {
    const { el } = await mount()
    await typeAll(el)
    await enter(el, 'country', 'US')
    await enter(el, 'region', 'CA')
    const before = { value: el.value, region: control(el, 'region').tagName }

    el.reset()
    await settled(el)

    expect(before).toEqual({ value: { ...TYPED, region: 'CA', country: 'US' }, region: 'SELECT' })
    expect(el.value).toEqual({
      firstName: '',
      lastName: '',
      addressLine1: '',
      city: '',
      region: '',
      postalCode: '',
      country: '',
    })
    const country = control(el, 'country')
    expect([country.tagName, country.value, control(el, 'region').tagName]).toEqual([
      'SELECT',
      '',
      'INPUT',
    ])
  })

  // Kills: Enter on a select submitting a half-filled address, or Enter in a text field submitting nothing or twice.
  it('AC-4: Enter in the country or the state select submits nothing; Enter in each text field submits the holding form once', async () => {
    const { el, submits } = await mount()
    await enter(el, 'country', 'US')

    control(el, 'country').dispatchEvent(enterKey())
    control(el, 'region').dispatchEvent(enterKey())
    await settled(el)
    expect([control(el, 'region').tagName, submits()]).toEqual(['SELECT', 0])

    await enter(el, 'country', 'GB')
    const counts: number[] = []
    for (const field of [...TEXT_FIELDS, 'region']) {
      control(el, field).dispatchEvent(enterKey())
      await settled(el)
      counts.push(submits())
    }
    expect(counts).toEqual(counts.map((_, i) => i + 1))
  })
})
