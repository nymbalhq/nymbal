// The store's header and footer, rendered by nymbal-site-header and nymbal-site-footer: edit the links here.

export const HEADER = {
  logo: 'Nymbal',
  accountHref: '/account',
  links: [
    { href: '/category/apparel', label: 'Apparel' },
    { href: '/category/home', label: 'Home' },
    { href: '/category/electronics', label: 'Electronics' },
    { href: '/category/books', label: 'Books' },
    { href: '/products', label: 'All Products' },
  ],
}

export const FOOTER_COLUMNS = [
  {
    heading: 'Shop',
    links: [
      { href: '/products', label: 'All Products' },
      { href: '/category/apparel', label: 'Apparel' },
      { href: '/category/home', label: 'Home' },
      { href: '/category/electronics', label: 'Electronics' },
      { href: '/category/books', label: 'Books' },
    ],
  },
  {
    heading: 'Account',
    links: [
      { href: '/account', label: 'My Account' },
      { href: '/account/orders', label: 'Order History' },
      { href: '/account/login', label: 'Sign In' },
      { href: '/account/register', label: 'Create Account' },
    ],
  },
  {
    heading: 'About',
    links: [
      { href: '/about', label: 'About Us' },
      { href: '/contact', label: 'Contact' },
      { href: '/shipping', label: 'Shipping & Returns' },
      { href: '/privacy', label: 'Privacy Policy' },
    ],
  },
]
