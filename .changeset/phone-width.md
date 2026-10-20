---
'@nymbalhq/admin': patch
'create-nymbal-app': patch
---

The admin and the Astro account pages fit a phone. Below the `md` breakpoint (768 px) the admin sidebar is off-canvas:
a menu button in the top bar (`data-testid="admin-nav-toggle"`, `aria-expanded`) opens it over the page, and choosing
a link or tapping the backdrop closes it; `main` and the top bar drop their 240 px offset and the live ticker is
hidden. The dashboard, order detail, product edit, customer profile and media grids stack on narrow screens. At `md`
and up the admin is unchanged. The Astro account sidebar no longer widens the page on a phone (468 px at 412): its
link row scrolls inside the column.
