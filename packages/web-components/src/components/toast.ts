import { css, html } from 'lit'
import { repeat } from 'lit/directives/repeat.js'
import { baseStyles, NymbalElement, propertiesOf, type ElementSchema } from '../base-element.js'

type ToastType = 'success' | 'error' | 'warning' | 'info'

interface ToastItem {
  id: number
  message: string
  type: ToastType
}

const SCHEMA: ElementSchema = {
  tag: 'nymbal-toast',
  reactName: 'Toast',
  attributes: [
    { name: 'position', prop: 'position', type: 'string' },
    { name: 'duration-ms', prop: 'durationMs', type: 'number' },
  ],
  events: [],
  parts: ['item', 'message', 'close'],
  slots: [],
  children: false,
}

let nextId = 0

export class NymbalToast extends NymbalElement {
  static override schema = SCHEMA
  static override properties = propertiesOf(SCHEMA)

  static override styles = [
    baseStyles,
    css`
      :host {
        position: fixed;
        z-index: var(--nymbal-z-toast, 300);
        display: flex;
        flex-direction: column;
        gap: var(--nymbal-spacing-sm, 0.5rem);
        pointer-events: none;
        font-family: var(--nymbal-font-family, system-ui, -apple-system, sans-serif);
      }
      :host([position='top-right']),
      :host(:not([position])) {
        top: var(--nymbal-spacing-lg, 1.5rem);
        right: var(--nymbal-spacing-lg, 1.5rem);
      }
      :host([position='top-left']) {
        top: var(--nymbal-spacing-lg, 1.5rem);
        left: var(--nymbal-spacing-lg, 1.5rem);
      }
      :host([position='bottom-right']) {
        bottom: var(--nymbal-spacing-lg, 1.5rem);
        right: var(--nymbal-spacing-lg, 1.5rem);
      }
      :host([position='bottom-left']) {
        bottom: var(--nymbal-spacing-lg, 1.5rem);
        left: var(--nymbal-spacing-lg, 1.5rem);
      }
      [part~='item'] {
        pointer-events: auto;
        display: flex;
        align-items: center;
        gap: var(--nymbal-spacing-sm, 0.5rem);
        padding: var(--nymbal-spacing-sm, 0.5rem) var(--nymbal-spacing-md, 1rem);
        border-radius: var(--nymbal-radius-md, 0.375rem);
        box-shadow: var(--nymbal-shadow-lg, 0 10px 15px rgba(0, 0, 0, 0.1));
        font-size: var(--nymbal-font-size-sm, 0.875rem);
        background: var(--nymbal-color-surface, #ffffff);
        color: var(--nymbal-color-text, #18181b);
        border: 1px solid var(--nymbal-color-border, #e4e4e7);
        animation: nymbal-toast-in var(--nymbal-transition-normal, 200ms ease) forwards;
        max-width: 360px;
      }
      [part~='item'][data-type='success'] {
        border-left: 3px solid var(--nymbal-color-success, #16a34a);
      }
      [part~='item'][data-type='error'] {
        border-left: 3px solid var(--nymbal-color-error, #dc2626);
      }
      [part~='item'][data-type='warning'] {
        border-left: 3px solid var(--nymbal-color-warning, #d97706);
      }
      [part~='item'][data-type='info'] {
        border-left: 3px solid var(--nymbal-color-accent, #2563eb);
      }
      [part~='close'] {
        background: none;
        border: none;
        cursor: pointer;
        color: var(--nymbal-color-text-muted, #71717a);
        font-size: var(--nymbal-font-size-base, 1rem);
        padding: 0;
        margin-left: auto;
      }
      @keyframes nymbal-toast-in {
        from {
          opacity: 0;
          transform: translateY(-8px);
        }
        to {
          opacity: 1;
          transform: translateY(0);
        }
      }
    `,
  ]

  private _items: ToastItem[] = []

  override connectedCallback(): void {
    super.connectedCallback()
    this.setAttribute('data-testid', 'toast')
  }

  show(message: string, type: ToastType = 'info'): void {
    const durationMs = Number(this.getAttribute('duration-ms')) || 4000
    const item: ToastItem = { id: ++nextId, message, type }
    this._items = [...this._items, item]
    this.requestUpdate()
    setTimeout(() => this.dismiss(item.id), durationMs)
  }

  private dismiss(id: number): void {
    const remaining = this._items.filter((i) => i.id !== id)
    if (remaining.length === this._items.length) return
    this._items = remaining
    this.requestUpdate()
  }

  protected override render() {
    return repeat(
      this._items,
      (item) => item.id,
      (item) => html`
        <div part="item" class="nymbal-toast-item" data-type=${item.type} role="alert">
          <span part="message">${item.message}</span>
          <button
            type="button"
            part="close"
            class="nymbal-toast-close"
            aria-label="Dismiss"
            @click=${() => this.dismiss(item.id)}
          >
            ×
          </button>
        </div>
      `,
    )
  }

  static showGlobal(message: string, type: ToastType = 'info'): void {
    let toastEl = document.querySelector('nymbal-toast') as NymbalToast | null
    if (!toastEl) {
      toastEl = document.createElement('nymbal-toast') as NymbalToast
      document.body.appendChild(toastEl)
    }
    toastEl.show(message, type)
  }
}
