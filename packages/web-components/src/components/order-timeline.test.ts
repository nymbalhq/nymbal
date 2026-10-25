import fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  renderableEntries,
  TIMELINE_LABELS,
  timelineEntries,
  timelineTime,
  type TimelineKind,
} from '../__fixtures__/server-data.js'
import { renderElement } from '../ssr/index.js'

// AC-3: `nymbal-order-timeline` renders one `entry` per served entry whose kind it knows and whose `at` is a date, in
// the served order (it sorts, merges and invents nothing). Each entry carries its kind, its kind's label and a
// `<time datetime>` equal to `at`, whose text is the pinned en-GB format in the `time-zone` given (UTC when none is
// given or the zone is unknown). The last entry is `aria-current="step"`. With no renderable entry the element renders
// nothing. `renderElement` gives the server the same entries, labels and times as the browser's render.
//
// The process runs in a zone far from UTC, so an element that formats in the host's zone shows a different hour.

const TAG = 'nymbal-order-timeline'
const HOST_ZONE = 'Pacific/Kiritimati'
const ZONES = [
  'UTC',
  'Europe/London',
  'America/New_York',
  'Asia/Kolkata',
  'Australia/Adelaide',
  'Pacific/Chatham',
  'Not/AZone',
]
const ALL_PARTS = ['entry', 'heading', 'label', 'list', 'time', 'timeline']

let hostZone: string | undefined

beforeAll(() => {
  hostZone = process.env.TZ
  process.env.TZ = HOST_ZONE
  expect(new Intl.DateTimeFormat().resolvedOptions().timeZone, 'the host zone for this file').toBe(
    HOST_ZONE,
  )
})

afterAll(() => {
  if (hostZone === undefined) delete process.env.TZ
  else process.env.TZ = hostZone
})

interface Shown {
  testid: string | null
  kind: string | null
  label: string
  datetime: string | null
  time: string
  current: string | null
}

const collapse = (s: string | null | undefined): string => (s ?? '').replace(/\s+/g, ' ').trim()

/** Nodes in `root` (not in nested roots) carrying this part token, in document order. */
function withPart(root: ParentNode, part: string): Element[] {
  return [...root.querySelectorAll('[part]')].filter((n) =>
    (n.getAttribute('part') ?? '').split(/\s+/).includes(part),
  )
}

/** Every part name rendered in `root`, sorted and once each. */
function partsOf(root: ParentNode): string[] {
  return [
    ...new Set(
      [...root.querySelectorAll('[part]')].flatMap((n) =>
        (n.getAttribute('part') ?? '').split(/\s+/).filter((p) => p !== ''),
      ),
    ),
  ].sort()
}

/** The root's text without its styles, whitespace collapsed. */
function textOf(root: ParentNode): string {
  const copy = document.createElement('div')
  for (const node of root.childNodes) copy.append(document.importNode(node, true))
  for (const style of copy.querySelectorAll('style')) style.remove()
  return collapse(copy.textContent)
}

/** What each rendered entry shows. */
function shownIn(root: ParentNode): Shown[] {
  return withPart(root, 'entry').map((li) => {
    const time = withPart(li, 'time')[0]
    return {
      testid: li.getAttribute('data-testid'),
      kind: li.getAttribute('data-kind'),
      label: collapse(withPart(li, 'label')[0]?.textContent),
      datetime: time?.localName === 'time' ? time.getAttribute('datetime') : null,
      time: collapse(time?.textContent),
      current: li.getAttribute('aria-current'),
    }
  })
}

/** What the served entries must show: the renderable ones, in served order, the last the current step. */
function expectedFrom(
  entries: Array<{ kind: string; at: string }>,
  zone: string | undefined,
): Shown[] {
  const kept = renderableEntries(entries)
  return kept.map((e, i) => ({
    testid: 'timeline-entry',
    kind: e.kind,
    label: TIMELINE_LABELS[e.kind as TimelineKind],
    datetime: e.at,
    time: timelineTime(e.at, zone),
    current: i === kept.length - 1 ? 'step' : null,
  }))
}

function attributesOf(entries: unknown, zone: string | undefined): Record<string, string> {
  return {
    entries: typeof entries === 'string' ? entries : JSON.stringify(entries),
    ...(zone !== undefined && { 'time-zone': zone }),
  }
}

async function mount(attributes: Record<string, string>): Promise<HTMLElement> {
  expect(customElements.get(TAG), `${TAG} is defined by registerComponents()`).toBeDefined()
  document.body.innerHTML = ''
  const el = document.createElement(TAG)
  for (const [name, value] of Object.entries(attributes)) el.setAttribute(name, value)
  document.body.append(el)
  await (el as HTMLElement & { updateComplete: Promise<unknown> }).updateComplete
  return el
}

async function settle(el: HTMLElement): Promise<void> {
  await (el as HTMLElement & { updateComplete: Promise<unknown> }).updateComplete
}

/** The server's shadow content for these attributes, parsed inert. */
function serverRoot(attributes: Record<string, string>): DocumentFragment {
  const template = document.createElement('template')
  template.innerHTML = renderElement(TAG, { attributes })
  const first = template.content.firstElementChild?.firstElementChild
  const shadow = first?.localName === 'template' ? (first as HTMLTemplateElement).content : null
  expect(shadow, `${TAG}'s server render holds a declarative shadow root`).not.toBeNull()
  return shadow!
}

const zone = fc.option(fc.constantFrom(...ZONES), { nil: undefined })

describe('AC-3: nymbal-order-timeline renders the served entries', () => {
  it('AC-3: property: one entry per served entry with a known kind and a valid at, in served order, each with its kind, label, datetime equal to at and its time in the given zone (else UTC), the last aria-current="step"; none renderable renders nothing', async () => {
    await fc.assert(
      fc.asyncProperty(timelineEntries(), zone, async (entries, tz) => {
        const el = await mount(attributesOf(entries, tz))
        const root = el.shadowRoot!
        const expected = expectedFrom(entries, tz)

        expect(shownIn(root)).toEqual(expected)
        expect(partsOf(root), 'parts rendered').toEqual(expected.length > 0 ? ALL_PARTS : [])
        expect(
          withPart(root, 'heading').map((h) => collapse(h.textContent)),
          'the heading',
        ).toEqual(expected.length > 0 ? ['Order progress'] : [])
        expect(
          withPart(root, 'timeline').map((s) => s.getAttribute('data-testid')),
          'the section',
        ).toEqual(expected.length > 0 ? ['order-timeline'] : [])
        expect(textOf(root) === '', 'renders no text exactly when nothing is renderable').toBe(
          expected.length === 0,
        )
      }),
      { numRuns: 120 },
    )
  })

  it('AC-3: property: renderElement on the server gives the same entries, labels, datetimes and times as the browser render of the same attributes, in the given zone (else UTC)', async () => {
    await fc.assert(
      fc.asyncProperty(timelineEntries(), zone, async (entries, tz) => {
        const attributes = attributesOf(entries, tz)
        const server = shownIn(serverRoot(attributes))
        const client = shownIn((await mount(attributes)).shadowRoot!)
        expect(server).toEqual(client)
        expect(server).toEqual(expectedFrom(entries, tz))
      }),
      { numRuns: 60 },
    )
  })

  it('AC-3: entries that are not a list of entries (unparseable JSON, an object, null, a number) take a rendered timeline to nothing', async () => {
    const served = [
      { kind: 'placed', at: '2026-10-25T09:00:00.000Z' },
      { kind: 'paid', at: '2026-10-25T09:00:03.000Z' },
    ]
    const el = await mount(attributesOf(served, undefined))
    const before = withPart(el.shadowRoot!, 'entry').length
    expect(before, 'the served entries render first').toBe(served.length)

    for (const value of [
      'not json',
      '{"kind":"paid","at":"2026-10-25T09:00:03.000Z"}',
      'null',
      '42',
    ]) {
      el.setAttribute('entries', JSON.stringify(served))
      await settle(el)
      expect(withPart(el.shadowRoot!, 'entry').length, `restored before ${value}`).toBe(before)

      el.setAttribute('entries', value)
      await settle(el)
      expect(partsOf(el.shadowRoot!), `entries="${value}"`).toEqual([])
    }
  })
})
