// The store's header and footer, rendered by nymbal-site-header and nymbal-site-footer: edit the links here.

export const HEADER = {
  logo: 'Nymbal',
  accountHref: '/account',
  links: [
    { href: '/products', label: 'Shop' },
    { href: '/products?category=new', label: 'New Arrivals' },
    { href: '/products?category=sale', label: 'Sale' },
  ],
}

export const FOOTER_COLUMNS = [
  {
    heading: 'Shop',
    links: [
      { href: '/products', label: 'All Products' },
      { href: '/products?category=new', label: 'New Arrivals' },
      { href: '/products?category=sale', label: 'Sale' },
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
