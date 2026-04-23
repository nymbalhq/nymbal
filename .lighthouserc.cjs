const isCI = !!process.env.CI
const template = process.env.NYMBAL_TEMPLATE ?? 'astro'
const port = template === 'nextjs' ? 3000 : 4321
const baseURL = `http://localhost:${port}`

module.exports = {
  ci: {
    collect: {
      url: [
        `${baseURL}/`,
        `${baseURL}/products`,
      ],
      numberOfRuns: isCI ? 3 : 1,
      settings: isCI
        ? {}
        : { throttlingMethod: 'provided' },
    },
    assert: isCI
      ? {
          assertions: {
            'categories:performance': ['error', { minScore: 0.9 }],
            'categories:accessibility': ['error', { minScore: 1.0 }],
            'largest-contentful-paint': ['error', { maxNumericValue: 2500 }],
            'cumulative-layout-shift': ['error', { maxNumericValue: 0.1 }],
            'interactive': ['error', { maxNumericValue: 3500 }],
          },
        }
      : {
          // Local: warn only, don't fail
          assertions: {
            'categories:performance': ['warn', { minScore: 0.9 }],
            'categories:accessibility': ['warn', { minScore: 1.0 }],
          },
        },
    upload: {
      target: 'temporary-public-storage',
    },
  },
}
