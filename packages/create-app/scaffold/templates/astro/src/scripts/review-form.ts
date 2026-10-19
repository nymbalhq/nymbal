import { client } from '../lib/client.js'
import { submitOnce } from '../lib/submit-once.js'

const form = document.getElementById('review-form') as HTMLFormElement | null
const messageEl = document.getElementById('review-form-message')

submitOnce(form, async () => {
  if (!form || !messageEl) return

  const productId = form.dataset.productId ?? ''
  const formData = new FormData(form)
  const rating = Number(formData.get('rating'))
  const title = String(formData.get('title'))
  const body = String(formData.get('body'))

  try {
    await client.adapter.reviews.submit({ productId, rating, title, body })
    messageEl.textContent = 'Thank you for your review!'
    messageEl.style.display = 'block'
    messageEl.style.color = 'var(--nymbal-color-success, #16a34a)'
    form.reset()
  } catch {
    messageEl.textContent = 'Something went wrong. Please try again.'
    messageEl.style.display = 'block'
    messageEl.style.color = 'var(--nymbal-color-error, #dc2626)'
  }
})
