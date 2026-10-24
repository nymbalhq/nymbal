import { css, html, nothing } from 'lit'
import {
  baseStyles,
  NymbalElement,
  parsedJson,
  propertiesOf,
  type ElementSchema,
} from '../base-element.js'
import { navigateOnClick } from '../navigate.js'

const SCHEMA: ElementSchema = {
  tag: 'nymbal-site-header',
  reactName: 'SiteHeader',
  attributes: [
    { name: 'links', prop: 'links', type: 'json' },
    { name: 'logo', prop: 'logo', type: 'string' },
    { name: 'account-href', prop: 'accountHref', type: 'string' },
  ],
  events: [],
  parts: ['header', 'logo', 'nav', 'link', 'account', 'toggle', 'actions'],
  // The page's own search bar and mini-cart, light-DOM children with `slot="search"` and `slot="cart"`.
  slots: ['search', 'cart'],
  children: true,
}

interface Link {
  label: string
  href: string
}

/**
 * The store's header: the logo, the navigation (behind a toggle on a narrow screen, with no script needed), the
 * account link, and the page's search bar and mini-cart in its `search` and `cart` slots.
 */
export class NymbalSiteHeader extends NymbalElement {
  static override schema = SCHEMA
  static override properties = propertiesOf(SCHEMA)
  static override styles = [
    baseStyles,
    css`
      :host {
        display: block;
        position: sticky;
        top: 0;
        z-index: var(--nymbal-z-dropdown, 100);
        font-family: var(--nymbal-font-family, system-ui, -apple-system, sans-serif);
      }
      [part~='header'] {
        background-color: var(--nymbal-color-surface, #ffffff);
        border-bottom: 1px solid var(--nymbal-color-border, #e4e4e7);
      }
      .inner {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: var(--nymbal-spacing-md, 1rem);
        max-width: 72rem;
        margin-inline: auto;
        padding: var(--nymbal-spacing-sm, 0.5rem) var(--nymbal-spacing-md, 1rem);
      }
      [part~='logo'] {
        flex-shrink: 0;
        font-size: var(--nymbal-font-size-lg, 1.125rem);
        font-weight: var(--nymbal-font-weight-bold, 700);
        letter-spacing: -0.02em;
        color: var(--nymbal-color-primary, #18181b);
        text-decoration: none;
      }
      [part~='logo']:hover {
        color: var(--nymbal-color-accent, #2563eb);
      }
      .toggle-input {
        position: absolute;
        width: 1px;
        height: 1px;
        overflow: hidden;
        clip: rect(0 0 0 0);
        white-space: nowrap;
      }
      [part~='toggle'] {
        display: flex;
        flex-direction: column;
        justify-content: center;
        gap: 4px;
        width: 28px;
        height: 28px;
        margin-left: auto;
        padding: 2px;
        cursor: pointer;
      }
      .line {
        display: block;
        width: 100%;
        height: 2px;
        border-radius: 1px;
        background-color: var(--nymbal-color-primary, #18181b);
        transition:
          transform var(--nymbal-transition-fast, 150ms ease),
          opacity var(--nymbal-transition-fast, 150ms ease);
      }
      .toggle-input:checked ~ [part~='toggle'] .line:nth-child(1) {
        transform: translateY(6px) rotate(45deg);
      }
      .toggle-input:checked ~ [part~='toggle'] .line:nth-child(2) {
        opacity: 0;
      }
      .toggle-input:checked ~ [part~='toggle'] .line:nth-child(3) {
        transform: translateY(-6px) rotate(-45deg);
      }
      .menu {
        display: none;
        flex-direction: column;
        gap: var(--nymbal-spacing-md, 1rem);
        width: 100%;
        padding-block: var(--nymbal-spacing-sm, 0.5rem);
      }
      .toggle-input:checked ~ .menu {
        display: flex;
      }
      [part~='nav'] {
        display: flex;
        flex-direction: column;
        gap: var(--nymbal-spacing-xs, 0.25rem);
      }
      [part~='link'] {
        display: block;
        padding: var(--nymbal-spacing-xs, 0.25rem) var(--nymbal-spacing-sm, 0.5rem);
        font-size: var(--nymbal-font-size-sm, 0.875rem);
        font-weight: var(--nymbal-font-weight-medium, 500);
        color: var(--nymbal-color-text, #18181b);
        text-decoration: none;
        border-radius: var(--nymbal-radius-sm, 0.25rem);
        transition:
          background-color var(--nymbal-transition-fast, 150ms ease),
          color var(--nymbal-transition-fast, 150ms ease);
      }
      [part~='link']:hover,
      [part~='account']:hover {
        background-color: var(--nymbal-color-border, #e4e4e7);
        color: var(--nymbal-color-accent, #2563eb);
      }
      [part~='actions'] {
        display: flex;
        align-items: center;
        gap: var(--nymbal-spacing-sm, 0.5rem);
      }
      [part~='account'] {
        display: flex;
        align-items: center;
        justify-content: center;
        width: 36px;
        height: 36px;
        color: var(--nymbal-color-text, #18181b);
        text-decoration: none;
        border-radius: var(--nymbal-radius-full, 9999px);
      }
      @media (min-width: 641px) {
        .inner {
          padding-inline: var(--nymbal-spacing-lg, 1.5rem);
        }
      }
      @media (min-width: 769px) {
        [part~='toggle'] {
          display: none;
        }
        .inner {
          flex-wrap: nowrap;
          padding-block: var(--nymbal-spacing-md, 1rem);
        }
        .menu {
          display: flex;
          flex: 1;
          flex-direction: row;
          align-items: center;
          justify-content: space-between;
          width: auto;
          gap: var(--nymbal-spacing-lg, 1.5rem);
          padding-block: 0;
        }
        [part~='nav'] {
          flex-direction: row;
        }
      }
    `,
  ]

  declare links: unknown
  declare logo: string | undefined
  declare accountHref: string | undefined

  protected override render() {
    const links = parsedJson<Link[]>(this, 'links', this.links)
    return html`
      <header part="header" data-testid="site-header">
        <div class="inner">
          ${this.logo === undefined
            ? nothing
            : html`<a part="logo" href="/" @click=${navigateOnClick}>${this.logo}</a>`}
          <input
            type="checkbox"
            id="nav-toggle"
            class="toggle-input"
            aria-label="Toggle navigation"
          />
          <label part="toggle" for="nav-toggle" aria-hidden="true">
            <span class="line"></span>
            <span class="line"></span>
            <span class="line"></span>
          </label>
          <div class="menu">
            <nav part="nav" aria-label="Main navigation">
              ${(Array.isArray(links) ? links : []).map(
                (link) =>
                  html`<a part="link" href=${link.href} @click=${navigateOnClick}
                    >${link.label}</a
                  >`,
              )}
            </nav>
            <div part="actions">
              <slot name="search"></slot>
              ${this.accountHref === undefined
                ? nothing
                : html`<a
                    part="account"
                    href=${this.accountHref}
                    aria-label="Account"
                    @click=${navigateOnClick}
                  >
                    <svg
                      width="20"
                      height="20"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                      <circle cx="12" cy="7" r="4" />
                    </svg>
                  </a>`}
              <slot name="cart"></slot>
            </div>
          </div>
        </div>
      </header>
    `
  }
}
