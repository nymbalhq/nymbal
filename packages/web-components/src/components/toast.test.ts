import { describe, it, expect, vi } from 'vitest'
import { NymbalToast } from './toast.js'

function createToast(): NymbalToast {
  const el = document.createElement('nymbal-toast') as NymbalToast
  document.body.appendChild(el)
  return el
}

describe('nymbal-toast', () => {
  it('connectedCallback sets data-testid', () => {
    const el = createToast()
    expect(el.getAttribute('data-testid')).toBe('toast')
  })

  it('show adds a toast item with correct type', async () => {
    const el = createToast()
    el.show('Hello', 'success')
    const item = el.querySelector('.nymbal-toast-item')
    expect(item).toBeTruthy()
    expect(item?.getAttribute('data-type')).toBe('success')
    expect(item?.textContent).toContain('Hello')
  })

  it('show adds close button with aria-label', () => {
    const el = createToast()
    el.show('Test message', 'info')
    const closeBtn = el.querySelector('.nymbal-toast-close') as HTMLButtonElement
    expect(closeBtn).toBeTruthy()
    expect(closeBtn.getAttribute('aria-label')).toBe('Dismiss')
  })

  it('close button dismisses the toast', () => {
    const el = createToast()
    el.show('Dismiss me', 'warning')
    const closeBtn = el.querySelector('.nymbal-toast-close') as HTMLButtonElement
    closeBtn.click()
    expect(el.querySelector('.nymbal-toast-item')).toBeNull()
  })

  it('toast auto-dismisses after durationMs', async () => {
    vi.useFakeTimers()
    const el = createToast()
    el.setAttribute('duration-ms', '100')
    el.show('Auto dismiss', 'error')
    expect(el.querySelector('.nymbal-toast-item')).toBeTruthy()
    vi.advanceTimersByTime(200)
    expect(el.querySelector('.nymbal-toast-item')).toBeNull()
    vi.useRealTimers()
  })

  it('showGlobal creates element if none exists', () => {
    document.body.innerHTML = ''
    NymbalToast.showGlobal('Global toast', 'info')
    const toast = document.querySelector('nymbal-toast')
    expect(toast).toBeTruthy()
  })

  it('shows multiple toasts stacked', () => {
    const el = createToast()
    el.show('First', 'success')
    el.show('Second', 'error')
    expect(el.querySelectorAll('.nymbal-toast-item')).toHaveLength(2)
  })

  it('role=alert is set on toast items', () => {
    const el = createToast()
    el.show('Accessible', 'info')
    const item = el.querySelector('.nymbal-toast-item')
    expect(item?.getAttribute('role')).toBe('alert')
  })
})
