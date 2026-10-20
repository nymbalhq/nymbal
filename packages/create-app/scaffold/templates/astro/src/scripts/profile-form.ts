import { client } from '../lib/client.js'
import { submitOnce } from '../lib/submit-once.js'

const form = document.getElementById('profile-form') as HTMLFormElement | null
const messageEl = document.getElementById('profile-message')

function populateForm() {
  const profile = client.auth.getState().customer
  if (!profile) return

  const firstNameEl = document.getElementById('profile-firstName') as HTMLInputElement
  const lastNameEl = document.getElementById('profile-lastName') as HTMLInputElement
  const emailEl = document.getElementById('profile-email') as HTMLInputElement
  const phoneEl = document.getElementById('profile-phone') as HTMLInputElement

  if (firstNameEl) firstNameEl.value = profile.firstName ?? ''
  if (lastNameEl) lastNameEl.value = profile.lastName ?? ''
  if (emailEl) emailEl.value = profile.email ?? ''
  if (phoneEl) phoneEl.value = profile.phone ?? ''
}

// Load profile data
async function init() {
  try {
    await client.auth.loadProfile()
  } catch {
    // ignore
  }
  populateForm()
}

client.auth.subscribe(populateForm)
init()

submitOnce(form, async () => {
  if (!form || !messageEl) return

  const firstName = (document.getElementById('profile-firstName') as HTMLInputElement)?.value
  const lastName = (document.getElementById('profile-lastName') as HTMLInputElement)?.value
  const phone = (document.getElementById('profile-phone') as HTMLInputElement)?.value

  const submitBtn = form.querySelector('[data-testid="profile-save"]') as HTMLButtonElement | null
  if (submitBtn) submitBtn.textContent = 'Saving...'

  try {
    await client.auth.updateProfile({ firstName, lastName, phone })
    messageEl.textContent = 'Profile updated successfully.'
    messageEl.style.color = 'var(--nymbal-color-success, #16a34a)'
    messageEl.style.display = 'block'
  } catch (err) {
    messageEl.textContent = err instanceof Error ? err.message : 'Failed to update profile.'
    messageEl.style.color = 'var(--nymbal-color-error, #dc2626)'
    messageEl.style.display = 'block'
  } finally {
    if (submitBtn) submitBtn.textContent = 'Save Changes'
  }
})
