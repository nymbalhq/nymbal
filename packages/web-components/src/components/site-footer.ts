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
  tag: 'nymbal-site-footer',
  reactName: 'SiteFooter',
  // `[{ heading, links: [{ label, href }], text? }]`; `year` for the copyright line (this year when absent).
  attributes: [
    { name: 'columns', prop: 'columns', type: 'json' },
    { name: 'year', prop: 'year', type: 'number' },
  ],
  events: [],
  parts: ['footer', 'column', 'heading', 'link', 'legal'],
  slots: [],
  children: false,
}

interface Column {
  heading: string
  links?: Array<{ label: string; href: string }>
  text?: string
}

/** The store's footer: columns of links (or a line of text) under their headings, and the copyright line. */
export class NymbalSiteFooter extends NymbalElement {
  static override schema = SCHEMA
  static override properties = propertiesOf(SCHEMA)
  static override styles = [
    baseStyles,
    css`
      :host {
        display: block;
        margin-top: auto;
        font-family: var(--nymbal-font-family, system-ui, -apple-system, sans-serif);
      }
      [part~='footer'] {
        background-color: var(--nymbal-color-primary, #18181b);
        color: var(--nymbal-color-text-inverse, #ffffff);
      }
      .inner {
        max-width: 72rem;
        margin-inline: auto;
        padding: 3rem var(--nymbal-spacing-md, 1rem) var(--nymbal-spacing-lg, 1.5rem);
      }
      .columns {
        display: grid;
        grid-template-columns: 1fr;
        gap: var(--nymbal-spacing-xl, 2rem);
        margin-bottom: var(--nymbal-spacing-xl, 2rem);
      }
      @media (min-width: 641px) {
        .inner {
          padding-inline: var(--nymbal-spacing-lg, 1.5rem);
        }
      }
      @media (min-width: 641px) {
        .columns {
          grid-template-columns: repeat(3, 1fr);
        }
      }
      [part~='heading'] {
        margin: 0 0 var(--nymbal-spacing-md, 1rem);
        line-height: 1.2;
        font-size: var(--nymbal-font-size-sm, 0.875rem);
        font-weight: var(--nymbal-font-weight-bold, 700);
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--nymbal-color-text-inverse, #ffffff);
      }
      ul {
        display: flex;
        flex-direction: column;
        gap: var(--nymbal-spacing-sm, 0.5rem);
        margin: 0;
        padding: 0;
        list-style: none;
      }
      [part~='link'] {
        font-size: var(--nymbal-font-size-sm, 0.875rem);
        color: var(--nymbal-color-text-inverse, #ffffff);
        opacity: 0.7;
        text-decoration: none;
        transition: opacity var(--nymbal-transition-fast, 150ms ease);
      }
      [part~='link']:hover {
        opacity: 1;
      }
      .text {
        max-width: 28ch;
        margin: 0;
        font-size: var(--nymbal-font-size-sm, 0.875rem);
        line-height: 1.6;
        opacity: 0.7;
      }
      [part~='legal'] {
        margin: 0;
        padding-top: var(--nymbal-spacing-lg, 1.5rem);
        border-top: 1px solid rgba(255, 255, 255, 0.1);
        font-size: var(--nymbal-font-size-xs, 0.75rem);
        opacity: 0.5;
      }
    `,
  ]

  declare columns: unknown
  declare year: number | undefined

  protected override render() {
    const columns = parsedJson<Column[]>(this, 'columns', this.columns)
    const year =
      this.year === undefined || Number.isNaN(this.year) ? new Date().getFullYear() : this.year
    return html`
      <footer part="footer" data-testid="site-footer">
        <div class="inner">
          <div class="columns">
            ${(Array.isArray(columns) ? columns : []).map(
              (column) => html`
                <div part="column">
                  <h2 part="heading">${column.heading}</h2>
                  ${column.text === undefined ? nothing : html`<p class="text">${column.text}</p>`}
                  ${(column.links ?? []).length === 0
                    ? nothing
                    : html`<ul>
                        ${column.links!.map(
                          (link) =>
                            html`<li>
                              <a part="link" href=${link.href} @click=${navigateOnClick}
                                >${link.label}</a
                              >
                            </li>`,
                        )}
                      </ul>`}
                </div>
              `,
            )}
          </div>
          <p part="legal">&copy; ${year} All rights reserved.</p>
        </div>
      </footer>
    `
  }
}
