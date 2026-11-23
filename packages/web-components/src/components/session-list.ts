import '@nymbalhq/sdk/ns/auth'
import { css, html, nothing } from 'lit'
import type { CustomerSession } from '@nymbalhq/types'
import { apiErrorCode } from '../api-error.js'
import { baseStyles, NymbalElement, propertiesOf, type ElementSchema } from '../base-element.js'
import { buttonStyles, fieldStyles } from '../view-styles.js'

const SCHEMA: ElementSchema = {
  tag: 'nymbal-session-list',
  reactName: 'SessionList',
  attributes: [],
  events: [
    {
      name: 'nymbal:sessions:signed-out',
      prop: 'onSignedOut',
      detail: 'Record<string, never>',
    },
  ],
  parts: [
    'list',
    'row',
    'device',
    'current',
    'signed-in',
    'last-active',
    'end',
    'end-all',
    'error',
  ],
  slots: [],
  children: false,
}

const when = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })

/**
 * The devices the signed-in customer is signed in on, each with a "Sign out", and "Sign out everywhere". Once this
 * device's own session has ended it fires `nymbal:sessions:signed-out`, and the page decides where to go.
 */
export class NymbalSessionList extends NymbalElement {
  static override schema = SCHEMA
  static override properties = propertiesOf(SCHEMA)
  static override styles = [
    baseStyles,
    buttonStyles,
    fieldStyles,
    css`
      [part~='list'] {
        margin: 0 0 var(--nymbal-spacing-md, 1rem);
        padding: 0;
        list-style: none;
      }
      [part~='row'] {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: var(--nymbal-spacing-xs, 0.25rem) var(--nymbal-spacing-md, 1rem);
        padding: var(--nymbal-spacing-sm, 0.5rem) 0;
        font-size: var(--nymbal-font-size-sm, 0.875rem);
        border-bottom: 1px solid var(--nymbal-color-border, #e4e4e7);
      }
      [part~='device'] {
        font-weight: var(--nymbal-font-weight-medium, 500);
      }
      [part~='current'] {
        padding: 0 var(--nymbal-spacing-sm, 0.5rem);
        font-size: var(--nymbal-font-size-xs, 0.75rem);
        color: var(--nymbal-color-text-inverse, #ffffff);
        background: var(--nymbal-color-primary, #18181b);
        border-radius: var(--nymbal-radius-full, 9999px);
      }
      [part~='signed-in'],
      [part~='last-active'] {
        color: var(--nymbal-color-text-muted, #71717a);
      }
      [part~='end'] {
        margin-left: auto;
      }
    `,
  ]

  /** null until the list has loaded for the signed-in customer. */
  private sessions: CustomerSession[] | null = null
  /** The customer the list was loaded for, or null while signed out. */
  private loadedFor: string | null = null
  /** A request of this element is in flight, or this device has signed out: every button is disabled. */
  private busy = false
  private error: string | null = null

  protected override stores() {
    return [this.client.auth]
  }

  protected override willUpdate(): void {
    if (!this.readsStores) return
    const { isAuthenticated, customer } = this.client.auth.getState()
    const signedIn = isAuthenticated ? (customer?.id ?? '') : null
    if (signedIn === this.loadedFor) return
    this.loadedFor = signedIn
    this.sessions = null
    if (signedIn !== null) void this.load()
  }

  private async load(): Promise<void> {
    try {
      this.sessions = await this.client.auth.sessions()
      this.error = null
    } catch {
      this.error = 'Unable to load your devices.'
    }
    this.requestUpdate()
  }

  /** Runs one end request: the SDK is called before the first await, so a second click finds `busy` set. */
  private run(request: () => Promise<void>, done: () => void, gone?: () => void): void {
    if (this.busy) return
    this.busy = true
    this.error = null
    const sent = request()
    this.requestUpdate()
    sent.then(
      () => {
        done()
        this.requestUpdate()
      },
      (err: unknown) => {
        this.busy = false
        if (gone !== undefined && apiErrorCode(err) === 'auth.session_not_found') gone()
        else this.error = 'Signing out failed. Please try again.'
        this.requestUpdate()
      },
    )
  }

  private signedOut(): void {
    this.dispatchEvent(
      new CustomEvent('nymbal:sessions:signed-out', { bubbles: true, composed: true, detail: {} }),
    )
  }

  private forget(session: CustomerSession): void {
    this.sessions = (this.sessions ?? []).filter((s) => s.id !== session.id)
  }

  private end(session: CustomerSession): void {
    this.run(
      () => this.client.auth.endSession(session.id),
      () => {
        this.forget(session)
        // This device's buttons stay disabled once it is signed out: the page leaves.
        if (session.current) this.signedOut()
        else this.busy = false
      },
      () => this.forget(session),
    )
  }

  private endAll(): void {
    this.run(
      () => this.client.auth.signOutEverywhere(),
      () => this.signedOut(),
    )
  }

  private renderRow(s: CustomerSession) {
    return html`<li part="row" data-testid="session-row" data-current=${String(s.current)}>
      <span part="device" data-testid="session-device">${s.device}</span>
      ${s.current
        ? html`<span part="current" data-testid="session-current">This device</span>`
        : nothing}
      <span part="signed-in"
        >Signed in
        <time data-testid="session-signed-in" datetime=${s.signedInAt}
          >${when.format(new Date(s.signedInAt))}</time
        ></span
      >
      <span part="last-active"
        >Last active
        <time data-testid="session-last-active" datetime=${s.lastActiveAt}
          >${when.format(new Date(s.lastActiveAt))}</time
        ></span
      >
      <button
        type="button"
        part="end"
        class="btn btn-secondary"
        data-testid="session-end"
        ?disabled=${this.busy}
        @click=${() => this.end(s)}
      >
        Sign out
      </button>
    </li>`
  }

  protected override render() {
    const error =
      this.error === null
        ? nothing
        : html`<div part="error" role="alert" data-testid="sessions-error">${this.error}</div>`
    if (this.sessions === null) return error
    return html`
      ${error}
      <ul part="list" data-testid="session-list">
        ${this.sessions.map((s) => this.renderRow(s))}
      </ul>
      <button
        type="button"
        part="end-all"
        class="btn btn-secondary"
        data-testid="sessions-end-all"
        ?disabled=${this.busy}
        @click=${() => this.endAll()}
      >
        Sign out everywhere
      </button>
    `
  }
}
