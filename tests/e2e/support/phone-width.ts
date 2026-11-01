import type { Page } from '@playwright/test'
import { expect } from './fixtures'

/** The widest viewport these journeys accept as a phone's: the `*-mobile` projects set Pixel 7's 412 px. */
const PHONE_MAX = 480

export interface PhoneWidths {
  /** The document's laid-out width. */
  scrollWidth: number
  /** The layout viewport the browser gives the page. */
  innerWidth: number
  /** The viewport the project sets. */
  viewport: number
  /** The three, for a failure message. */
  measured: string
}

/**
 * The page's widths beside the phone's. A page fits when scrollWidth ≤ viewport and innerWidth = viewport: mobile
 * Chrome zooms out to fit a page wider than its viewport, which raises innerWidth to the page's width, so
 * scrollWidth ≤ innerWidth alone would pass on the defect. Chromium rounds a sub-pixel layout up by one pixel on a page
 * that fits (413 at 412), so a journey allows one pixel.
 */
export async function phoneWidths(page: Page, name: string): Promise<PhoneWidths> {
  const viewport = page.viewportSize()?.width ?? Number.POSITIVE_INFINITY
  expect(viewport, 'a phone-width journey runs in a *-mobile project').toBeLessThanOrEqual(
    PHONE_MAX,
  )
  const { scrollWidth, innerWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }))
  return {
    scrollWidth,
    innerWidth,
    viewport,
    measured: `${name}: scrollWidth ${scrollWidth}, innerWidth ${innerWidth}, viewport ${viewport}`,
  }
}
