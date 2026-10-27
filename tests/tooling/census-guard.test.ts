// Reads: nothing
import fc from 'fast-check'
import { describe, expect, it } from 'vitest'
import { refusalMessage, refusedTests, type RefusedKind } from '../../scripts/test-census'

// AC-1 to AC-3: the census refuses three shapes of test, whatever else the file holds: R1 presence-only (every
// assertion says only that something is there), R2 mock-call-only (every assertion is on a mock's calls) and R3
// constant-initial-state (the only act is construction and every assertion compares a read to a literal). An outcome
// test of the same shape, one that asserts what an act returned or left behind, is accepted. The shapes below are the
// ones the suite used to carry; each refused one is paired with the accepted test it should have been.

/** The imports and the local read helper the suite's element tests carry. */
const HEADER = `import { beforeEach, describe, expect, it, test, vi } from 'vitest'

function shadow(el: Element): ShadowRoot {
  const root = el.shadowRoot
  if (root === null) throw new Error('no shadow root')
  return root
}

`

const file = (...tests: string[]): string => HEADER + tests.join('\n')

// R1: presence only
const R1_DOM = `it('renders an add button', async () => {
  const el = await createElement()
  const btn = shadow(el).querySelector('[data-testid="add-to-cart"]')
  expect(btn).toBeTruthy()
  expect(el.shadowRoot).toBeDefined()
})
`
const R1_E2E = `test('login page renders the form', async ({ page }) => {
  await page.goto('/account/login')
  await expect(page.getByTestId('login-form')).toBeVisible()
  expect(await page.getByTestId('login-email').count()).toBeGreaterThan(0)
})
`
const R1_NO_THROW = `it('migrates twice without throwing', () => {
  expect(() => migrate(db)).not.toThrow()
  expect(() => migrate(db)).not.toThrow()
})
`
const R1_EXISTS = `it('exposes a login function', () => {
  const { result } = renderHook(() => useAuth())
  expect(typeof result.current.login).toBe('function')
  expect(result.current.customer).not.toBeNull()
})
`
const R1_HELPER = `const present = (x: unknown) => expect(x).toBeDefined()
it('the header carries a search box', () => {
  present(document.querySelector('nymbal-search'))
})
`
const R1_PRECONDITION_HELPER = `async function devOutput(args: string[]): Promise<string> {
  const run = await startDev(args)
  const res = await fetch(run.base + '/api/products')
  expect(res.status).toBe(200)
  return run.output()
}
it('with --verbose, dev prints a DEBUG line', async () => {
  const out = await devOutput(['--verbose'])
  expect(out.split('DEBUG').length).toBeGreaterThan(0)
})
`
const R1_CONSTANT_PROPERTY = `it('the drawer is there for any input', () => {
  const el = document.querySelector('nymbal-cart-drawer')
  fc.assert(fc.property(fc.constant(1), () => expect(el).toBeTruthy()))
})
`
const R1_BUILT_IN_CLASS = `it('creates the cart element', () => {
  const el = document.createElement('nymbal-cart')
  expect(el).toBeInstanceOf(HTMLElement)
})
`
const R1_GONE_BEFORE_ACT = `it('the error box starts empty', async () => {
  const el = await createElement()
  expect(shadow(el).querySelector('.error')).toBeFalsy()
})
`
// The outcome tests of the same shapes
const HELPER_OUTCOME = `const expectLines = (el: Element, n: number) =>
  expect(shadow(el).querySelectorAll('li').length).toBe(n)
it('adding a variant lists one more line', async () => {
  const el = await createElement()
  const before = shadow(el).querySelectorAll('li').length
  await el.add('var-1')
  expectLines(el, before + 1)
})
`
const CONSTANT_PROPERTY_OUTCOME = `it('one line totals its price', () => {
  fc.assert(fc.property(fc.constant(1250), (price) => expect(totalOf([{ price }])).toBe(price)))
})
`
const REJECTS_CLASS = `it('cancel of an unknown order is NotFoundError', async () => {
  const env = await setup()
  await expect(env.orderService.cancel('missing', 'x', 'admin:1')).rejects.toBeInstanceOf(NotFoundError)
})
`
const OWN_CLASS = `import { ConflictError } from '../errors'
it('a second claim of the same key is a ConflictError', async () => {
  await service.claim('key-1')
  const result = await service.claim('key-1').catch((error: unknown) => error)
  expect(result).toBeInstanceOf(ConflictError)
})
`
const HIDDEN_AFTER_ACT = `test('Escape closes the drawer', async ({ page }) => {
  await page.goto('/')
  await page.getByTestId('cart-open').click()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('cart-drawer')).toBeHidden()
})
`
const FALSY_AFTER_ACT = `it('close() leaves the drawer closed', () => {
  const el = createDrawer()
  el.open()
  el.close()
  expect(el.isOpen).toBeFalsy()
})
`
const NOT_VISIBLE_AFTER_ACT = `test('dismissing the toast removes it', async ({ page }) => {
  await page.getByTestId('toast-dismiss').click()
  await expect(page.getByTestId('toast')).not.toBeVisible()
})
`
const DOM_OUTCOME = `it('clicking add puts the variant in the cart', async () => {
  const el = await createElement()
  shadow(el).querySelector('button')!.click()
  expect(client.cart.getState().items.map((line) => line.variantId)).toEqual([el.variantId])
})
`
const E2E_OUTCOME = `test('a bad password shows the error the API returns', async ({ page, request }) => {
  await page.goto('/account/login')
  const response = await request.post('/api/auth/login', { data: { email: 'a@b.c', password: 'wrong' } })
  const body = await response.json()
  await page.getByTestId('login-submit').click()
  await expect(page.getByTestId('login-error')).toHaveText(body.error.message)
})
`
const THROW_OUTCOME = `it('refuses a schema from the future', () => {
  expect(() => migrate(futureDb)).toThrow(/newer than this build/)
})
`

// R2: a mock's call as the only assertion
const R2_CALLED_WITH = `it('calls logout with the refresh token from the cookie', async () => {
  const service = makeAuthService()
  const { adapter, invoke } = makeAdapter()
  registerAuthRoutes(adapter, service)
  await invoke('POST', '/api/auth/logout', { cookies: { refresh: 'tok' } })
  expect(service.logout).toHaveBeenCalledWith('tok')
  expect(service.logout).toHaveBeenCalledTimes(1)
})
`
const R2_MOCK_RECORD = `it('passes the id through', () => {
  const spy = vi.fn()
  run(spy, 'id-1')
  expect(spy.mock.calls[0]?.[0]).toEqual({ id: 'id-1' })
})
`
const MOCK_OUTCOME = `it('logout drops the session the cookie named', async () => {
  const service = makeAuthService()
  const { adapter, invoke } = makeAdapter()
  registerAuthRoutes(adapter, service)
  const before = service.sessions().length
  const response = await invoke('POST', '/api/auth/logout', { cookies: { refresh: 'tok' } })
  expect(response.status).toBe(204)
  expect(service.sessions().length).toBe(before - 1)
})
`

// R3: a constant initial state
const R3_INITIAL = `it('initial state is empty', () => {
  const store = createCartStore(makeAdapter())
  expect(store.getState().items).toHaveLength(0)
  expect(store.getState().loading).toBe(false)
  expect(store.getState().error).toBeNull()
})
`
const R3_RENDER = `it('renders a button with the add label', async () => {
  const el = await createElement()
  const btn = shadow(el).querySelector('button')
  expect(btn).toBeTruthy()
  expect(btn.textContent).toBe('Add to cart')
})
`
const R3_HOOKED = `describe('token manager', () => {
  let tm: TokenManager
  beforeEach(() => {
    tm = new TokenManager()
  })
  it('starts without a token', () => {
    expect(tm.getAccessToken()).toBeNull()
    expect(tm.isAuthenticated()).toBe(false)
  })
})
`
const INITIAL_OUTCOME = `it('adding a line grows the count by its quantity', () => {
  const store = createCartStore(makeAdapter())
  const before = store.getState().itemCount
  store.add({ variantId: 'v1', qty: 2 })
  expect(store.getState().itemCount).toBe(before + 2)
})
`
const HOOK_ACTS = `describe('cart', () => {
  let store: CartStore
  beforeEach(async () => {
    store = createCartStore(makeAdapter())
    await store.add({ variantId: 'v1', qty: 1 })
  })
  it('holds the line added before it', () => {
    expect(store.getState().items).toHaveLength(1)
  })
})
`
const PURE_EXAMPLE = `it('parses a decimal price into minor units', () => {
  expect(parsePrice('12.50')).toBe(1250)
})
`
const PROPERTY = `it('the total is the sum of the lines', () => {
  fc.assert(
    fc.property(fc.array(fc.nat()), (prices) => {
      const store = createCartStore(makeAdapter())
      expect(store.total(prices)).toBe(prices.reduce((a, b) => a + b, 0))
    }),
  )
})
`

const REFUSED: Array<[name: string, source: string, kind: RefusedKind]> = [
  ['renders an add button', R1_DOM, 'R1'],
  ['login page renders the form', R1_E2E, 'R1'],
  ['migrates twice without throwing', R1_NO_THROW, 'R1'],
  ['exposes a login function', R1_EXISTS, 'R1'],
  ['the header carries a search box', R1_HELPER, 'R1'],
  ['with --verbose, dev prints a DEBUG line', R1_PRECONDITION_HELPER, 'R1'],
  ['the drawer is there for any input', R1_CONSTANT_PROPERTY, 'R1'],
  ['creates the cart element', R1_BUILT_IN_CLASS, 'R1'],
  ['the error box starts empty', R1_GONE_BEFORE_ACT, 'R1'],
  ['calls logout with the refresh token from the cookie', R2_CALLED_WITH, 'R2'],
  ['passes the id through', R2_MOCK_RECORD, 'R2'],
  ['initial state is empty', R3_INITIAL, 'R3'],
  ['renders a button with the add label', R3_RENDER, 'R3'],
  ['starts without a token', R3_HOOKED, 'R3'],
]

const ACCEPTED: Array<[name: string, source: string]> = [
  ['clicking add puts the variant in the cart', DOM_OUTCOME],
  ['a bad password shows the error the API returns', E2E_OUTCOME],
  ['refuses a schema from the future', THROW_OUTCOME],
  ['adding a variant lists one more line', HELPER_OUTCOME],
  ['one line totals its price', CONSTANT_PROPERTY_OUTCOME],
  ['cancel of an unknown order is NotFoundError', REJECTS_CLASS],
  ['a second claim of the same key is a ConflictError', OWN_CLASS],
  ['Escape closes the drawer', HIDDEN_AFTER_ACT],
  ['close() leaves the drawer closed', FALSY_AFTER_ACT],
  ['dismissing the toast removes it', NOT_VISIBLE_AFTER_ACT],
  ['logout drops the session the cookie named', MOCK_OUTCOME],
  ['adding a line grows the count by its quantity', INITIAL_OUTCOME],
  ['holds the line added before it', HOOK_ACTS],
  ['parses a decimal price into minor units', PURE_EXAMPLE],
  ['the total is the sum of the lines', PROPERTY],
]

const PATH = 'packages/sdk/src/store/cart-store.test.ts'

const verdicts = (source: string): Array<[string, RefusedKind]> =>
  refusedTests(source, PATH).map((t) => [t.name, t.kind])

describe('AC-1 to AC-3: each refused shape is named with its kind', () => {
  for (const [name, source, kind] of REFUSED) {
    it(`${kind}: "${name}" is refused`, () => {
      expect(verdicts(file(source))).toEqual([[name, kind]])
    })
  }
})

describe('AC-1 to AC-3: the outcome test of the same shape is accepted', () => {
  for (const [name, source] of ACCEPTED) {
    it(`"${name}" is accepted`, () => {
      expect(verdicts(file(source))).toEqual([])
    })
  }
})

describe('the refusal names the test, the kind and what an outcome assertion looks like', () => {
  it('each message carries the test name, its kind, the matchers it used and an example assertion', () => {
    const [refused] = refusedTests(file(R2_CALLED_WITH), PATH)
    const message = refusalMessage(PATH, refused!)
    expect(
      message.startsWith(`${PATH}: test "calls logout with the refresh token from the cookie"`),
    ).toBe(true)
    expect(message).toContain('R2 mock-call-only')
    expect(message).toContain('toHaveBeenCalledWith, toHaveBeenCalledTimes')
    expect(message).toMatch(/e\.g\. expect\(/)
  })

  it('a skipped test and a property test are never judged', () => {
    const skipped = R1_DOM.replace("it('", "it.skip('")
    expect(verdicts(file(skipped, PROPERTY))).toEqual([])
  })
})

describe('property: a file refuses exactly its refused tests, in order', () => {
  const shapes = [
    ...REFUSED.map(([name, source, kind]) => ({ name, source, kind: kind as RefusedKind | null })),
    ...ACCEPTED.map(([name, source]) => ({ name, source, kind: null })),
  ]

  it('for any sequence of the shapes above, the verdicts are the refused ones with their kinds', () => {
    fc.assert(
      fc.property(fc.array(fc.nat({ max: shapes.length - 1 }), { maxLength: 12 }), (picks) => {
        const chosen = picks.map((i) => shapes[i]!)
        const found = verdicts(file(...chosen.map((s) => s.source)))
        const wanted = chosen
          .filter((s) => s.kind !== null)
          .map((s) => [s.name, s.kind] as [string, RefusedKind])
        expect(found).toEqual(wanted)
        expect(found.length).toBeLessThanOrEqual(chosen.length)
      }),
      { numRuns: 60 },
    )
  })
})
