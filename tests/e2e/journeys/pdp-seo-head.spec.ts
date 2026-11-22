import { randomUUID } from 'node:crypto'
import type { APIRequestContext, Page } from '@playwright/test'
import { adminToken } from '../support/checkout'
import { API_URL, csrf } from '../support/csrf'
import { isNext } from '../support/elements'
import { expect, test } from '../support/fixtures'

// On both templates the product page's head reads the product's SEO title and description: a set SEO title is the
// whole <title> (no store suffix) and a set SEO description the meta description (and, on Astro, the Open Graph pair;
// Next emits none). Blank fields keep today's head. A title holding markup is text in the head and runs nothing.

interface Made {
  slug: string
  name: string
}

/** A product made through the admin API with the given SEO fields, once its storefront document is served. */
async function makeProduct(
  request: APIRequestContext,
  fields: { name: string; description: string; seoTitle: string; seoDescription: string },
): Promise<Made> {
  const token = await adminToken(request)
  const slug = `seo-head-${randomUUID().slice(0, 8)}`
  const made = await request.post(`${API_URL}/api/admin/products`, {
    headers: { ...(await csrf(request)), authorization: `Bearer ${token}` },
    data: {
      slug,
      ...fields,
      status: 'active',
      variants: [{ sku: `SEO-${slug}`, name: 'Default', priceMinor: 2200, stock: 4, options: [] }],
    },
  })
  expect(made.status(), `POST /api/admin/products: ${await made.text()}`).toBe(201)
  await expect
    .poll(async () => (await request.get(`${API_URL}/api/products/${slug}`)).status(), {
      timeout: 10_000,
    })
    .toBe(200)
  return { slug, name: fields.name }
}

async function headOf(page: Page) {
  const content = async (selector: string) => {
    const tag = page.locator(selector)
    return (await tag.count()) === 0 ? null : tag.first().getAttribute('content')
  }
  return {
    title: await page.title(),
    description: await content('meta[name="description"]'),
    ogTitle: await content('meta[property="og:title"]'),
    ogDescription: await content('meta[property="og:description"]'),
  }
}

test.describe('AC-19: the product page head reads the product’s SEO fields', () => {
  test('AC-19: a product made with seoTitle and seoDescription shows them as its <title> and meta description (on Astro also og:title and og:description); one made with both blank shows "<name> | Nymbal" and its description', async ({
    page,
    request,
  }, testInfo) => {
    const tag = randomUUID().slice(0, 6)
    const seoTitle = `Waxed Field Tote ${tag} for the Daily Commute`
    const seoDescription = `A roomy waxed tote ${tag} with a zip pocket and sturdy handles, sized for the commute and weekend errands.`
    const set = await makeProduct(request, {
      name: `Field Tote ${tag}`,
      description: 'A tote for every day.',
      seoTitle,
      seoDescription,
    })
    const blank = await makeProduct(request, {
      name: `Plain Tote ${tag}`,
      description: 'A plain tote for errands.',
      seoTitle: '',
      seoDescription: '',
    })

    await page.goto(`/product/${set.slug}`)
    const setHead = await headOf(page)
    await page.goto(`/product/${blank.slug}`)
    const blankHead = await headOf(page)

    const og = (title: string, description: string) =>
      isNext(testInfo)
        ? { ogTitle: null, ogDescription: null }
        : { ogTitle: title, ogDescription: description }
    expect(setHead).toEqual({
      title: seoTitle,
      description: seoDescription,
      ...og(seoTitle, seoDescription),
    })
    expect({ title: blankHead.title, description: blankHead.description }).toEqual({
      title: `${blank.name} | Nymbal`,
      description: 'A plain tote for errands.',
    })
  })

  test('AC-19: an seoTitle holding </title><script> is the page title as text and runs nothing', async ({
    page,
    request,
  }) => {
    const seoTitle = 'Tote </title><script>window.__nymbalSeoXss=1</script>'
    const made = await makeProduct(request, {
      name: `Script Tote ${randomUUID().slice(0, 6)}`,
      description: 'A tote.',
      seoTitle,
      seoDescription: '',
    })

    await page.goto(`/product/${made.slug}`)
    await page.waitForLoadState('load')
    const ran = await page.evaluate(
      () => (window as unknown as { __nymbalSeoXss?: unknown }).__nymbalSeoXss,
    )

    expect([await page.title(), ran]).toEqual([seoTitle, undefined])
  })
})
