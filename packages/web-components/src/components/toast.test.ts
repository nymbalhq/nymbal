import { describe, it, expect, vi } from 'vitest'
import { NymbalToast } from './toast.js'

// The element is a Lit element that renders in an open shadow root, so its internals are read through `shadowRoot`,
// once its render has settled (`updateComplete`).

function shadow(el: Element): ShadowRoot {
  const root = el.shadowRoot
  if (root === null) throw new Error(`<${el.localName}> has no open shadow root`)
  return root
}

async function settled(el: Element): Promise<void> {
  await (el as Element & { updateComplete?: Promise<unknown> }).updateComplete
}

async function createToast(): Promise<NymbalToast> {
  const el = document.createElement('nymbal-toast') as NymbalToast
  document.body.appendChild(el)
  await settled(el)
  return el
}

async function show(
  el: NymbalToast,
  message: string,
  type: 'success' | 'error' | 'warning' | 'info',
): Promise<void> {
  el.show(message, type)
  await settled(el)
}

const items = (el: NymbalToast) => shadow(el).querySelectorAll('.nymbal-toast-item')

describe('nymbal-toast', () => {
  it('show adds a toast item with correct type', async () => {
    const el = await createToast()
    await show(el, 'Hello', 'success')
    const item = shadow(el).querySelector('.nymbal-toast-item')
    expect(item).toBeTruthy()
    expect(item?.getAttribute('data-type')).toBe('success')
    expect(item?.textContent).toContain('Hello')
  })

  it('close button dismisses the toast', async () => {
    const el = await createToast()
    await show(el, 'Dismiss me', 'warning')
    const closeBtn = shadow(el).querySelector('.nymbal-toast-close') as HTMLButtonElement
    closeBtn.click()
    await settled(el)
    expect(shadow(el).querySelector('.nymbal-toast-item')).toBeNull()
  })

  it('toast auto-dismisses after durationMs', async () => {
    vi.useFakeTimers()
    try {
      const el = await createToast()
      el.setAttribute('duration-ms', '100')
      await settled(el)
      await show(el, 'Auto dismiss', 'error')
      expect(shadow(el).querySelector('.nymbal-toast-item')).toBeTruthy()
      vi.advanceTimersByTime(200)
      await settled(el)
      expect(shadow(el).querySelector('.nymbal-toast-item')).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('showGlobal creates one toast element when none exists and reuses it after: every message shows in it', async () => {
    document.body.innerHTML = ''
    NymbalToast.showGlobal('Global toast', 'info')
    NymbalToast.showGlobal('Second toast', 'success')
    const hosts = document.querySelectorAll('nymbal-toast')
    expect(hosts).toHaveLength(1)
    const el = hosts[0] as NymbalToast
    await settled(el)
    expect(items(el)).toHaveLength(2)
    expect(shadow(el).textContent).toContain('Global toast')
    expect(shadow(el).textContent).toContain('Second toast')
  })

  it('shows multiple toasts stacked', async () => {
    const el = await createToast()
    const shown = [
      { message: 'First', type: 'success' },
      { message: 'Second', type: 'error' },
    ] as const
    for (const t of shown) await show(el, t.message, t.type)
    expect(items(el)).toHaveLength(2)
    // Stacked in the order shown, each item carrying its own type and message.
    const stacked = [...items(el)]
    expect(stacked.map((i) => i.getAttribute('data-type'))).toEqual(shown.map((t) => t.type))
    shown.forEach((t, n) => expect(stacked[n]?.textContent).toContain(t.message))
  })

  it('role=alert is set on toast items', async () => {
    const el = await createToast()
    await show(el, 'Accessible', 'info')
    const item = shadow(el).querySelector('.nymbal-toast-item')
    expect(item?.getAttribute('role')).toBe('alert')
  })
})
