import { html, nothing, type TemplateResult } from 'lit'
import { NymbalElement } from './base-element.js'

export interface FieldSpec {
  /** The input's id and test id, unique within the element's shadow root. */
  id: string
  name: string
  label: string
  type?: 'text' | 'email' | 'password' | 'tel'
  autocomplete: string
  required?: boolean
  disabled?: boolean
  minlength?: number
  placeholder?: string
  /** Set on the input when it changes, so typing is kept across renders. */
  value?: string
}

/** A labelled input; the label's `for` and the input share the element's shadow root. */
export function renderField(f: FieldSpec): TemplateResult {
  return html`
    <div part="field">
      <label part="label" for=${f.id}>${f.label}</label>
      <input
        part="input"
        id=${f.id}
        name=${f.name}
        type=${f.type ?? 'text'}
        autocomplete=${f.autocomplete}
        placeholder=${f.placeholder ?? nothing}
        minlength=${f.minlength ?? nothing}
        ?required=${f.required ?? false}
        ?disabled=${f.disabled ?? false}
        .value=${f.value ?? ''}
        data-testid=${f.id}
      />
    </div>
  `
}

/**
 * A view whose form makes one SDK call per submission. `requestSubmit()` and Enter still fire `submit` while the
 * button is disabled, so the pending flag, not the button, is the guard.
 */
export abstract class NymbalFormElement extends NymbalElement {
  protected pending = false
  protected error: string | null = null
  protected notice: string | null = null
  /** Keeps the submit disabled after a success, for a form whose page navigates away on it. */
  protected readonly lockOnSuccess: boolean = false

  /** Reads the fields and makes the call; it must call the SDK before its first `await`. */
  protected abstract send(): Promise<void>

  /** The error text a refusal shows. */
  protected failureText(err: unknown): string {
    return err instanceof Error && err.message !== '' ? err.message : 'Something went wrong.'
  }

  protected readonly onSubmit = (event: Event): void => {
    event.preventDefault()
    if (this.pending) return
    this.pending = true
    this.error = null
    this.notice = null
    const sent = this.send()
    this.requestUpdate()
    sent.then(
      () => this.settle(null),
      (err: unknown) => this.settle(this.failureText(err)),
    )
  }

  private settle(error: string | null): void {
    this.pending = error === null && this.lockOnSuccess
    this.error = error
    this.requestUpdate()
  }

  protected value(name: string): string {
    return this.renderRoot.querySelector<HTMLInputElement>(`[name="${name}"]`)?.value ?? ''
  }

  protected emit(name: string, detail: unknown): void {
    this.dispatchEvent(new CustomEvent(name, { bubbles: true, composed: true, detail }))
  }

  protected renderError(): TemplateResult | typeof nothing {
    return this.error === null
      ? nothing
      : html`<div part="error" role="alert">${this.error}</div>`
  }
}
