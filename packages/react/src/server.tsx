import { createElement, type ReactElement } from 'react'
import { renderElement } from '@nymbalhq/web-components/ssr'

// Node only: this module loads Lit SSR, so a server component imports it and no 'use client' module does.

/**
 * A Nymbal element's server render, as its generated wrapper's `serverHtml` and React's `dangerouslySetInnerHTML`
 * take it: the declarative shadow root and then `children` (light-DOM HTML, the checkout's payment element), without
 * the tag itself, which the wrapper renders with its attributes.
 */
export function renderNymbal(
  tag: string,
  attributes?: Record<string, string>,
  children?: string,
): { __html: string } {
  const html = renderElement(tag, { attributes, children })
  // Lit SSR escapes `>` in attribute values, so the first one closes the opening tag.
  return { __html: html.slice(html.indexOf('>') + 1, html.length - `</${tag}>`.length) }
}

export interface NymbalServerProps {
  tag: string
  /** The host's attributes; a JSON attribute's value is its JSON text. */
  attributes?: Record<string, string>
  /** Light-DOM HTML after the shadow root. */
  children?: string
}

/** A server-rendered element for a page with no client view of its own: the tag, its attributes and its render. */
export function NymbalServer({ tag, attributes, children }: NymbalServerProps): ReactElement {
  return createElement(tag, {
    ...attributes,
    dangerouslySetInnerHTML: renderNymbal(tag, attributes, children),
    suppressHydrationWarning: true,
  })
}
