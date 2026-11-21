import starlight from '@astrojs/starlight'
import { defineConfig } from 'astro/config'

// Pages come only from src/content/docs. The site builds to dist/ for any static host.
export default defineConfig({
  integrations: [
    starlight({
      title: 'Nymbal',
      description: 'An open source commerce platform: your store, your code, agents included.',
      social: [{ icon: 'github', label: 'GitHub', href: 'https://github.com/nymbalhq/nymbal' }],
      sidebar: [
        { label: 'Start', items: ['index', 'quickstart', 'configuration'] },
        {
          label: 'Guides',
          items: [
            'adapters',
            'agents',
            'assistant-data',
            'deploying',
            'importing',
            'upgrading',
            'wordpress',
          ],
        },
        { label: 'Reference', items: ['reference/cli'] },
        { label: 'Help', items: ['help'] },
      ],
    }),
  ],
})
