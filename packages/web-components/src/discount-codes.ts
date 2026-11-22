import { css, html, nothing } from 'lit'
import { cartCodeMessage, type CartCodeStatus } from '@nymbalhq/types'

/** The parts of the code block, listed in the schema of each element that renders it. */
export const CODE_PARTS = [
  'codes',
  'code-form',
  'code-input',
  'code-apply',
  'code-list',
  'code',
  'code-message',
  'code-remove',
  'code-error',
] as const

/** A code is 1 to 64 characters, as the cart's code route takes it. */
const CODE_MAX_LENGTH = 64

const CODE_UNCHECKED = "We couldn't check your code just now. Please try again."

/** What a refused code call says, by the API's code; an outage, a transport failure or anything else is a retry. */
const REFUSALS: Readonly<Record<string, string>> = {
  'cart.code_limit': 'You can add up to five codes.',
  'cart.code_invalid': 'Enter a valid code of up to 64 characters.',
  'cart.missing': 'Your cart has expired. Reload the page to start again.',
}

function refusalMessage(errorCode: string | null): string {
  return errorCode !== null && Object.hasOwn(REFUSALS, errorCode)
    ? REFUSALS[errorCode]!
    : CODE_UNCHECKED
}

/** The cart store's code calls: each resolves once the store holds the answer, or `error` and `errorCode` say why not. */
export interface CodeCart {
  getState(): { error: string | null; errorCode: string | null }
  addCode(code: string): Promise<void>
  removeCode(code: string): Promise<void>
}

export const codeStyles = css`
  [part~='codes'] {
    margin: 0 0 var(--nymbal-spacing-md, 1rem);
  }
  [part~='code-form'] {
    display: flex;
    flex-wrap: wrap;
    gap: var(--nymbal-spacing-sm, 0.5rem);
  }
  [part~='code-form'] label {
    flex-basis: 100%;
    font-size: var(--nymbal-font-size-sm, 0.875rem);
    color: var(--nymbal-color-text-muted, #71717a);
  }
  [part~='code-input'] {
    flex: 1;
    min-width: 0;
    padding: var(--nymbal-spacing-sm, 0.5rem);
    font: inherit;
    font-size: var(--nymbal-font-size-sm, 0.875rem);
    border: 1px solid var(--nymbal-color-border, #e4e4e7);
    border-radius: var(--nymbal-radius-md, 0.5rem);
  }
  [part~='code-error'] {
    margin: var(--nymbal-spacing-xs, 0.25rem) 0 0;
    font-size: var(--nymbal-font-size-sm, 0.875rem);
    color: var(--nymbal-color-error, #dc2626);
  }
  [part~='code-list'] {
    margin: var(--nymbal-spacing-sm, 0.5rem) 0 0;
    padding: 0;
    list-style: none;
  }
  [part~='code'] {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--nymbal-spacing-sm, 0.5rem);
    padding: var(--nymbal-spacing-xs, 0.25rem) 0;
    font-size: var(--nymbal-font-size-sm, 0.875rem);
  }
  [part~='code-message'] {
    flex: 1;
    color: var(--nymbal-color-text-muted, #71717a);
  }
  [part~='code'][data-status='rejected'] [part~='code-message'] {
    color: var(--nymbal-color-error, #dc2626);
  }
  [part~='code-remove'] {
    padding: 0;
    font: inherit;
    font-size: var(--nymbal-font-size-xs, 0.75rem);
    color: var(--nymbal-color-text-muted, #71717a);
    background: none;
    border: none;
    text-decoration: underline;
    cursor: pointer;
  }
  [part~='code-remove']:disabled {
    cursor: not-allowed;
  }
`

/**
 * The discount code block an element renders in its summary: the field, each code on the cart with what the engine
 * said of it, and why the last code call was refused. One code call at a time: Apply and every Remove are disabled
 * while one is in flight, so one click is one request.
 */
export class DiscountCodes {
  private busy = false
  private error: string | null = null

  constructor(
    private readonly host: { requestUpdate(): void },
    private readonly cart: () => CodeCart,
  ) {}

  /** The call, then the refusal shown or cleared; true when the cart took it. */
  private async run(call: (cart: CodeCart) => Promise<void>): Promise<boolean> {
    this.busy = true
    this.host.requestUpdate()
    const cart = this.cart()
    try {
      await call(cart)
      const { error, errorCode } = cart.getState()
      this.error = error === null ? null : refusalMessage(errorCode)
    } finally {
      this.busy = false
      this.host.requestUpdate()
    }
    return this.error === null
  }

  private readonly onApply = async (event: Event): Promise<void> => {
    event.preventDefault()
    const input = (event.currentTarget as HTMLFormElement).querySelector('input')
    const code = input?.value.trim() ?? ''
    if (this.busy || input === null || code === '') return
    // A refused code stays typed, to correct or send again.
    if (await this.run((cart) => cart.addCode(code))) input.value = ''
  }

  private remove(code: string): void {
    if (!this.busy) void this.run((cart) => cart.removeCode(code))
  }

  /** `disabled`: no code may change (an order is being placed, or was). */
  render(codes: readonly CartCodeStatus[], disabled = false) {
    const locked = disabled || this.busy
    return html`
      <div part="codes">
        <form part="code-form" novalidate @submit=${this.onApply}>
          <label for="discount-code-input">Discount code</label>
          <input
            part="code-input"
            id="discount-code-input"
            data-testid="discount-code-input"
            name="code"
            maxlength=${CODE_MAX_LENGTH}
            autocomplete="off"
            ?disabled=${disabled}
          />
          <button
            type="submit"
            part="code-apply"
            class="btn btn-secondary"
            data-testid="discount-code-apply"
            ?disabled=${locked}
          >
            Apply
          </button>
        </form>
        ${this.error === null
          ? nothing
          : html`<p part="code-error" role="alert" data-testid="discount-code-error">
              ${this.error}
            </p>`}
        ${codes.length === 0
          ? nothing
          : html`<ul part="code-list">
              ${codes.map(
                (c) => html`
                  <li
                    part="code"
                    data-testid="discount-code"
                    data-code=${c.code}
                    data-status=${c.status}
                  >
                    <span>${c.code}</span>
                    <span part="code-message" data-testid="discount-code-message"
                      >${cartCodeMessage(c)}</span
                    >
                    <button
                      type="button"
                      part="code-remove"
                      data-testid="discount-code-remove"
                      aria-label="Remove code ${c.code}"
                      ?disabled=${locked}
                      @click=${() => this.remove(c.code)}
                    >
                      Remove
                    </button>
                  </li>
                `,
              )}
            </ul>`}
      </div>
    `
  }
}
