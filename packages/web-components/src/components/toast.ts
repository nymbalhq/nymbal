import { injectStyles } from '../styles.js'

const STYLES = `
nymbal-toast {
  position: fixed;
  z-index: var(--nymbal-z-toast);
  display: flex;
  flex-direction: column;
  gap: var(--nymbal-spacing-sm);
  pointer-events: none;
  font-family: var(--nymbal-font-family);
}
nymbal-toast[position="top-right"],
nymbal-toast:not([position]) {
  top: var(--nymbal-spacing-lg);
  right: var(--nymbal-spacing-lg);
}
nymbal-toast[position="top-left"] {
  top: var(--nymbal-spacing-lg);
  left: var(--nymbal-spacing-lg);
}
nymbal-toast[position="bottom-right"] {
  bottom: var(--nymbal-spacing-lg);
  right: var(--nymbal-spacing-lg);
}
nymbal-toast[position="bottom-left"] {
  bottom: var(--nymbal-spacing-lg);
  left: var(--nymbal-spacing-lg);
}
nymbal-toast .nymbal-toast-item {
  pointer-events: auto;
  display: flex;
  align-items: center;
  gap: var(--nymbal-spacing-sm);
  padding: var(--nymbal-spacing-sm) var(--nymbal-spacing-md);
  border-radius: var(--nymbal-radius-md);
  box-shadow: var(--nymbal-shadow-lg);
  font-size: var(--nymbal-font-size-sm);
  background: var(--nymbal-color-surface);
  color: var(--nymbal-color-text);
  border: 1px solid var(--nymbal-color-border);
  animation: nymbal-toast-in var(--nymbal-transition-normal) forwards;
  max-width: 360px;
}
nymbal-toast .nymbal-toast-item[data-type="success"] {
  border-left: 3px solid var(--nymbal-color-success);
}
nymbal-toast .nymbal-toast-item[data-type="error"] {
  border-left: 3px solid var(--nymbal-color-error);
}
nymbal-toast .nymbal-toast-item[data-type="warning"] {
  border-left: 3px solid var(--nymbal-color-warning);
}
nymbal-toast .nymbal-toast-item[data-type="info"] {
  border-left: 3px solid var(--nymbal-color-accent);
}
nymbal-toast .nymbal-toast-close {
  background: none;
  border: none;
  cursor: pointer;
  color: var(--nymbal-color-text-muted);
  font-size: var(--nymbal-font-size-base);
  padding: 0;
  margin-left: auto;
}
@keyframes nymbal-toast-in {
  from { opacity: 0; transform: translateY(-8px); }
  to { opacity: 1; transform: translateY(0); }
}
`

const HTMLElementBase =
  typeof HTMLElement !== 'undefined' ? HTMLElement : (class {} as unknown as typeof HTMLElement)

export class NymbalToast extends HTMLElementBase {
  static get observedAttributes(): string[] {
    return ['position', 'duration-ms']
  }

  connectedCallback(): void {
    injectStyles('nymbal-toast', STYLES)
    this.setAttribute('data-testid', 'toast')
  }

  show(message: string, type: 'success' | 'error' | 'warning' | 'info' = 'info'): void {
    const durationMs = Number(this.getAttribute('duration-ms')) || 4000

    const item = document.createElement('div')
    item.className = 'nymbal-toast-item'
    item.setAttribute('data-type', type)
    item.setAttribute('role', 'alert')

    const text = document.createElement('span')
    text.textContent = message

    const close = document.createElement('button')
    close.className = 'nymbal-toast-close'
    close.setAttribute('aria-label', 'Dismiss')
    close.textContent = '×'
    close.addEventListener('click', () => this.dismiss(item))

    item.appendChild(text)
    item.appendChild(close)
    this.appendChild(item)

    setTimeout(() => this.dismiss(item), durationMs)
  }

  private dismiss(item: HTMLElement): void {
    if (item.parentNode === this) {
      this.removeChild(item)
    }
  }

  static showGlobal(message: string, type: 'success' | 'error' | 'warning' | 'info' = 'info'): void {
    let toastEl = document.querySelector('nymbal-toast') as NymbalToast | null
    if (!toastEl) {
      toastEl = document.createElement('nymbal-toast') as NymbalToast
      document.body.appendChild(toastEl)
    }
    toastEl.show(message, type)
  }
}
