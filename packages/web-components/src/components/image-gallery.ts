import { css, html, nothing, type PropertyValues } from 'lit'
import {
  baseStyles,
  NymbalElement,
  parsedJson,
  propertiesOf,
  type ElementSchema,
} from '../base-element.js'

const SCHEMA: ElementSchema = {
  tag: 'nymbal-image-gallery',
  reactName: 'ImageGallery',
  attributes: [{ name: 'images', prop: 'images', type: 'json' }],
  events: [],
  parts: ['main', 'thumbnails', 'thumbnail'],
  slots: [],
  children: false,
}

interface Image {
  url: string
  alt?: string
}

/** A product's images: the one shown, and a thumbnail per image (when there are several) that shows it. */
export class NymbalImageGallery extends NymbalElement {
  static override schema = SCHEMA
  static override properties = propertiesOf(SCHEMA)
  static override styles = [
    baseStyles,
    css`
      :host {
        display: block;
      }
      [part~='main'] {
        display: block;
        width: 100%;
        height: auto;
        aspect-ratio: 1 / 1;
        object-fit: cover;
        margin-bottom: var(--nymbal-spacing-sm, 0.5rem);
        border-radius: var(--nymbal-radius-lg, 0.75rem);
        background-color: var(--nymbal-color-border, #f4f4f5);
      }
      [part~='thumbnails'] {
        display: flex;
        gap: var(--nymbal-spacing-sm, 0.5rem);
        overflow-x: auto;
        padding-bottom: var(--nymbal-spacing-xs, 0.25rem);
      }
      [part~='thumbnail'] {
        flex-shrink: 0;
        width: 64px;
        height: 64px;
        padding: 0;
        border: 2px solid transparent;
        border-radius: var(--nymbal-radius-md, 0.5rem);
        background: none;
        overflow: hidden;
        cursor: pointer;
        transition: border-color var(--nymbal-transition-fast, 150ms ease);
      }
      [part~='thumbnail']:hover {
        border-color: var(--nymbal-color-border, #e4e4e7);
      }
      [part~='thumbnail'][aria-pressed='true'] {
        border-color: var(--nymbal-color-primary, #18181b);
      }
      [part~='thumbnail'] img {
        display: block;
        width: 100%;
        height: 100%;
        object-fit: cover;
      }
      @media (min-width: 641px) {
        [part~='thumbnail'] {
          width: 80px;
          height: 80px;
        }
      }
    `,
  ]

  declare images: unknown

  /** The image shown; a new list of images starts again at its first. */
  private shownIndex = 0

  protected override willUpdate(changed: PropertyValues): void {
    if (changed.has('images')) this.shownIndex = 0
  }

  private show(index: number): void {
    this.shownIndex = index
    this.requestUpdate()
  }

  protected override render() {
    const images = parsedJson<Image[]>(this, 'images', this.images)
    if (!Array.isArray(images) || images.length === 0) return nothing
    const main = images[this.shownIndex] ?? images[0]!
    return html`
      <img
        part="main"
        src=${main.url}
        alt=${main.alt ?? ''}
        width="600"
        height="600"
        fetchpriority="high"
        data-testid="product-gallery"
      />
      ${images.length > 1
        ? html`
            <div part="thumbnails">
              ${images.map(
                (image, i) => html`
                  <button
                    type="button"
                    part="thumbnail"
                    aria-label="Show image ${i + 1}"
                    aria-pressed=${i === this.shownIndex ? 'true' : 'false'}
                    @click=${() => this.show(i)}
                  >
                    <img src=${image.url} alt="" width="80" height="80" loading="lazy" />
                  </button>
                `,
              )}
            </div>
          `
        : nothing}
    `
  }
}
