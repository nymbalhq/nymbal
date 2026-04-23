const injected = new Set<string>()

export function injectStyles(tagName: string, css: string): void {
  if (injected.has(tagName)) return
  if (typeof document === 'undefined') return
  const style = document.createElement('style')
  style.setAttribute('data-nymbal', tagName)
  style.textContent = css
  document.head.appendChild(style)
  injected.add(tagName)
}
