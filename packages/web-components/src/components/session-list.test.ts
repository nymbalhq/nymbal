import fc from 'fast-check'
import { beforeEach, describe, expect, it } from 'vitest'
import type { NymbalClient } from '@nymbalhq/sdk'
import { setupMockClient } from '../testing/index.js'

// `nymbal-session-list` on the profile page: the devices the account is signed in on, each with a "Sign out", and
// "Sign out everywhere". It reads and ends sessions through the auth store (`sessions`, `endSession`,
// `signOutEverywhere`), which the mock client is given here; each call answers when the test says. The element fires
// `nymbal:sessions:signed-out` once this device's own session has ended, which the page follows to the sign-in page.

const TAG = 'nymbal-session-list'
const SIGNED_OUT = 'nymbal:sessions:signed-out'

interface Session {
  id: string
  device: string
  signedInAt: string
  lastActiveAt: string
  current: boolean
}

const THREE: Session[] = [
  {
    id: 'ses-this',
    device: 'Firefox on Windows',
    signedInAt: '2026-11-01T09:00:00.000Z',
    lastActiveAt: '2026-11-22T10:15:00.000Z',
    current: true,
  },
  {
    id: 'ses-phone',
    device: 'Safari on iPhone',
    signedInAt: '2026-10-12T18:30:00.000Z',
    lastActiveAt: '2026-11-21T07:45:00.000Z',
    current: false,
  },
  {
    id: 'ses-tablet',
    device: 'Safari on iPad',
    signedInAt: '2026-09-03T12:00:00.000Z',
    lastActiveAt: '2026-11-02T21:05:00.000Z',
    current: false,
  },
]

interface Deferred {
  promise: Promise<void>
  resolve(): void
  reject(err: unknown): void
}

function deferred(): Deferred {
  let resolve!: () => void
  let reject!: (err: unknown) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** An error as the SDK throws it for a refusal the API answered with `code`. */
function apiError(code: string, message: string): Error {
  return Object.assign(new Error(message), { name: 'NymbalApiError', code, status: 404 })
}

let client: NymbalClient

beforeEach(() => {
  client = setupMockClient()
})

type Auth = Record<string, unknown> & { setState(partial: Record<string, unknown>): void }

/** Gives the mock auth store its devices calls; each end answers with the next deferred the test hands it. */
function installSessions(list: Session[]) {
  const auth = (client as unknown as { auth: Auth }).auth
  const calls = { list: 0, end: [] as string[], endAll: 0 }
  const ends: Deferred[] = []
  const endAlls: Deferred[] = []
  auth['sessions'] = async () => {
    calls.list += 1
    return list.map((s) => ({ ...s }))
  }
  auth['endSession'] = (id: string) => {
    calls.end.push(id)
    const next = deferred()
    ends.push(next)
    return next.promise
  }
  auth['signOutEverywhere'] = () => {
    calls.endAll += 1
    const next = deferred()
    endAlls.push(next)
    return next.promise
  }
  return { auth, calls, ends, endAlls }
}

async function settled(el: Element): Promise<void> {
  await (el as Element & { updateComplete?: Promise<unknown> }).updateComplete
}

async function flush(el: Element): Promise<void> {
  for (let turn = 0; turn < 6; turn += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    await settled(el)
  }
}

/** The element, connected with the auth store signed in (or not), once its first load has settled. */
async function mount(signedIn = true) {
  expect(customElements.get(TAG), `${TAG} is defined by registerComponents()`).toBeDefined()
  const auth = (client as unknown as { auth: Auth }).auth
  if (signedIn)
    auth.setState({ isAuthenticated: true, customer: { id: 'cus-1', email: 'ada@example.test' } })
  document.body.innerHTML = ''
  const el = document.createElement(TAG)
  let fired = 0
  el.addEventListener(SIGNED_OUT, () => {
    fired += 1
  })
  document.body.appendChild(el)
  await flush(el)
  return { el, fired: () => fired }
}

const root = (el: Element): ShadowRoot => el.shadowRoot!
const byTestId = (el: Element, id: string): Element[] => [
  ...(el.shadowRoot ?? el).querySelectorAll(`[data-testid="${id}"]`),
]
const rows = (el: Element): Element[] => byTestId(el, 'session-row')
const deviceOf = (row: Element): string =>
  row.querySelector('[data-testid="session-device"]')?.textContent?.trim() ?? ''
const devicesListed = (el: Element): string[] => rows(el).map(deviceOf).sort()
const rowOf = (el: Element, device: string): Element => {
  const row = rows(el).find((r) => deviceOf(r) === device)
  if (row === undefined) throw new Error(`no session-row for ${device}`)
  return row
}
const endButton = (row: Element): HTMLButtonElement =>
  row.querySelector('[data-testid="session-end"]') as HTMLButtonElement
const endAllButton = (el: Element): HTMLButtonElement =>
  byTestId(el, 'sessions-end-all')[0] as HTMLButtonElement
const buttonsDisabled = (el: Element): boolean[] =>
  [...root(el).querySelectorAll('button')].map((b) => b.disabled)

/** What a row shows: its label, both times as tag and datetime, and whether it is marked this device. */
function shown(row: Element) {
  const signed = row.querySelector('[data-testid="session-signed-in"]')
  const active = row.querySelector('[data-testid="session-last-active"]')
  return [
    deviceOf(row),
    signed?.localName,
    signed?.getAttribute('datetime'),
    active?.localName,
    active?.getAttribute('datetime'),
    row.querySelector('[data-testid="session-current"]') !== null,
    row.getAttribute('data-current') === 'true',
  ]
}

const expectedRow = (s: Session) => [
  s.device.trim(),
  'time',
  s.signedInAt,
  'time',
  s.lastActiveAt,
  s.current,
  s.current,
]

const byLabel = (a: unknown[], b: unknown[]): number => String(a[0]).localeCompare(String(b[0]))

describe('AC-13: the session list', () => {
  // Defect: the wrong row (or none, or several) is marked this device; a time is shown with no machine value or
  // the other one's; a label a client chose is read as markup.
  it('AC-13: property: one session-row per session, exactly the current one marked, each label as text and both times as <time datetime> of its ISO value', async () => {
    const label = fc.oneof(
      fc.constantFrom(
        'Chrome on macOS',
        'Unknown device',
        '<img src=x onerror="window.__owned=1">',
        '<b>Edge</b>',
      ),
      fc.string({ minLength: 1, maxLength: 24 }).filter((s) => s.trim() !== ''),
    )
    const instant = fc
      .date({
        min: new Date('2020-01-01T00:00:00Z'),
        max: new Date('2030-01-01T00:00:00Z'),
        noInvalidDate: true,
      })
      .map((d) => d.toISOString())
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(label, { minLength: 1, maxLength: 4, selector: (s) => s.trim() }),
        fc.nat(),
        fc.array(fc.tuple(instant, instant), { minLength: 4, maxLength: 4 }),
        async (labels, at, times) => {
          client = setupMockClient()
          const sessions = labels.map((device, i) => ({
            id: `ses-${i}`,
            device,
            signedInAt: times[i]![0],
            lastActiveAt: times[i]![1],
            current: i === at % labels.length,
          }))
          installSessions(sessions)
          const { el } = await mount()

          expect(rows(el).map(shown).sort(byLabel)).toEqual(sessions.map(expectedRow).sort(byLabel))
          expect(byTestId(el, 'session-current')).toHaveLength(1)
          expect(root(el).querySelectorAll('img')).toHaveLength(0)
        },
      ),
      { numRuns: 25 },
    )
  })

  // Defect: the label is rendered as markup (unsafeHTML or innerHTML), so a client-chosen header runs script on the
  // account's other devices.
  it('AC-13: a device label holding <img onerror> markup renders as that text and makes no element', async () => {
    const markup = '<img src=x onerror="window.__owned=1">'
    installSessions([{ ...THREE[1]!, device: markup }, THREE[0]!])
    const { el } = await mount()

    expect(devicesListed(el)).toEqual([markup, 'Firefox on Windows'].sort())
    expect(root(el).querySelectorAll('img')).toHaveLength(0)
  })

  // Defect: Sign out on another device's row ends the wrong session, keeps the row, or tells the page this device
  // signed out (sending the shopper to the sign-in page).
  it('AC-13: session-end on another row ends that session, removes its row once it succeeds, and fires no event', async () => {
    const { calls, ends } = installSessions(THREE)
    const { el, fired } = await mount()

    endButton(rowOf(el, 'Safari on iPhone')).click()
    await flush(el)
    ends[0]!.resolve()
    await flush(el)

    expect(calls.end).toEqual(['ses-phone'])
    expect(devicesListed(el)).toEqual(['Firefox on Windows', 'Safari on iPad'])
    expect(fired()).toBe(0)
  })

  // Defect: the page is told this device signed out before the store said yes, or more than once.
  it.each([
    {
      what: 'session-end on this device’s row',
      press: (el: Element) => endButton(rowOf(el, 'Firefox on Windows')).click(),
    },
    { what: 'sessions-end-all', press: (el: Element) => endAllButton(el).click() },
  ])(
    'AC-13: $what fires nymbal:sessions:signed-out once, only after the request succeeds',
    async ({ press }) => {
      const { ends, endAlls } = installSessions(THREE)
      const { el, fired } = await mount()

      press(el)
      await flush(el)
      const beforeAnswer = fired()
      ;[...ends, ...endAlls].forEach((d) => d.resolve())
      await flush(el)

      expect([beforeAnswer, fired()]).toEqual([0, 1])
    },
  )

  // Defect: a refused sign-out is shown as done: the row goes, the page navigates away, no error says why.
  it.each([
    {
      what: 'session-end on another row',
      press: (el: Element) => endButton(rowOf(el, 'Safari on iPad')).click(),
    },
    {
      what: 'session-end on this device’s row',
      press: (el: Element) => endButton(rowOf(el, 'Firefox on Windows')).click(),
    },
    { what: 'sessions-end-all', press: (el: Element) => endAllButton(el).click() },
  ])(
    'AC-13: a rejection of $what shows sessions-error, keeps every row and fires nothing',
    async ({ press }) => {
      const { ends, endAlls } = installSessions(THREE)
      const { el, fired } = await mount()
      const before = devicesListed(el)
      expect(byTestId(el, 'sessions-error')).toHaveLength(0)

      press(el)
      await flush(el)
      ;[...ends, ...endAlls].forEach((d) => d.reject(new Error('The store is not answering.')))
      await flush(el)

      expect(byTestId(el, 'sessions-error')).toHaveLength(1)
      expect(devicesListed(el)).toEqual(before)
      expect(fired()).toBe(0)
    },
  )

  // Defect: a second press that lost the race to the first (the session is already gone) shows an error over a
  // sign-out that worked, and the dead row stays.
  it('AC-13: an auth.session_not_found answer on a row’s session-end removes the row and shows no error', async () => {
    const { ends } = installSessions(THREE)
    const { el } = await mount()

    endButton(rowOf(el, 'Safari on iPad')).click()
    await flush(el)
    ends[0]!.reject(apiError('auth.session_not_found', 'No such session.'))
    await flush(el)

    expect(devicesListed(el)).toEqual(['Firefox on Windows', 'Safari on iPhone'])
    expect(byTestId(el, 'sessions-error')).toHaveLength(0)
  })

  // Defect: the element asks for a guest's sessions (a 401 on every page load), or never loads once signed in.
  it('AC-13: it loads nothing while the auth store is unauthenticated, and loads once when it authenticates', async () => {
    const { auth, calls } = installSessions(THREE)
    const { el } = await mount(false)
    const whileSignedOut = calls.list

    auth.setState({ isAuthenticated: true, customer: { id: 'cus-1', email: 'ada@example.test' } })
    await flush(el)

    expect([whileSignedOut, calls.list]).toEqual([0, 1])
    expect(devicesListed(el)).toEqual(THREE.map((s) => s.device).sort())
  })
})

describe('AC-14: each button sends once while its request is in flight', () => {
  // Defect: the handler is not de-duplicated, so a double click sends a second end that answers 404 and shows an
  // error over a sign-out that worked; or another button stays live mid-request.
  it('AC-14: property: k rapid clicks (2 to 5) on one session-end make one endSession call, every button is disabled while it is in flight, and one row goes', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 2, max: 5 }), async (k) => {
        client = setupMockClient()
        const { calls, ends } = installSessions(THREE)
        const { el } = await mount()
        const button = endButton(rowOf(el, 'Safari on iPhone'))

        for (let i = 0; i < k; i += 1) button.click()
        await flush(el)
        const inFlight = buttonsDisabled(el)
        ends.forEach((d) => d.resolve())
        await flush(el)

        expect(calls.end).toEqual(['ses-phone'])
        expect(inFlight).toEqual(inFlight.map(() => true))
        expect(inFlight.length).toBeGreaterThanOrEqual(THREE.length + 1)
        expect(rows(el)).toHaveLength(THREE.length - 1)
      }),
      { numRuns: 8 },
    )
  })

  it('AC-14: property: k rapid clicks (2 to 5) on sessions-end-all make one signOutEverywhere call, and every button is disabled while it is in flight', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 2, max: 5 }), async (k) => {
        client = setupMockClient()
        const { calls, endAlls } = installSessions(THREE)
        const { el } = await mount()
        const button = endAllButton(el)

        for (let i = 0; i < k; i += 1) button.click()
        await flush(el)
        const inFlight = buttonsDisabled(el)
        endAlls.forEach((d) => d.resolve())
        await flush(el)

        expect(calls.endAll).toBe(1)
        expect(inFlight).toEqual(inFlight.map(() => true))
        expect(inFlight.length).toBeGreaterThanOrEqual(THREE.length + 1)
      }),
      { numRuns: 8 },
    )
  })
})
