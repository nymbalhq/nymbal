const thumbnails = document.getElementById('gallery-thumbnails')
const mainImage = document.getElementById('gallery-main-image') as HTMLImageElement | null

if (thumbnails && mainImage) {
  thumbnails.addEventListener('click', (e) => {
    const target = e.target as HTMLElement
    if (!target.classList.contains('pdp-thumbnail')) return

    const url = target.dataset.url
    const alt = target.dataset.alt

    if (url) {
      mainImage.src = url
      mainImage.alt = alt ?? ''
    }

    thumbnails
      .querySelectorAll('.pdp-thumbnail')
      .forEach((t) => t.classList.remove('active'))
    target.classList.add('active')
  })
}
