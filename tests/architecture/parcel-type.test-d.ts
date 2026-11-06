import type { Parcel } from '../../packages/types/src/index.js'

// A parcel carries all three dimensions or none: one or two of them is a type error, so a caller cannot build a
// parcel the adapters refuse at runtime. The root typecheck (`tsc -b` includes tests/**) fails if an expected error
// stops being one.

export const weightOnly: Parcel = { weightGrams: 500 }
export const allThree: Parcel = { weightGrams: 500, lengthMm: 300, widthMm: 200, heightMm: 100 }

// @ts-expect-error one dimension without the other two
export const oneDimension: Parcel = { weightGrams: 500, lengthMm: 300 }

// @ts-expect-error two dimensions without the third
export const twoDimensions: Parcel = { weightGrams: 500, lengthMm: 300, widthMm: 200 }

declare const parcel: Parcel
/** A defined `lengthMm` narrows a parcel to the member with all three dimensions as numbers. */
export const volume: number | null =
  parcel.lengthMm !== undefined ? parcel.lengthMm * parcel.widthMm * parcel.heightMm : null
