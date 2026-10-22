// In a landmark of its own: the header's links are in its shadow root, where a checker cannot tell the skip link
// comes before them, so it would count it as content outside every landmark.
export function SkipNav() {
  return (
    <nav aria-label="Skip link">
      <a href="#main" className="skip-nav">
        Skip to content
      </a>
    </nav>
  )
}
