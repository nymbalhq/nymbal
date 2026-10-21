// Signed in or registered: on to the page that sent the shopper here (`?redirect`), or the account.
document.addEventListener('nymbal:auth:signed-in', () => {
  window.location.href = new URLSearchParams(window.location.search).get('redirect') ?? '/account'
})
