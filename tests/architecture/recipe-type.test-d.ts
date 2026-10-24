import type { Recipe, RecipeValue } from '../../packages/types/src/index.js'
import type {
  SpecRecipe,
  SpecRecipeValue,
} from '../../packages/cli/src/recipes/fixtures/linked-project.js'

// AC-1, the type half: @nymbalhq/types exports `Recipe` and `RecipeValue` in the documented shape, which the tests use
// as SpecRecipe and SpecRecipeValue. Each is assignable to the other, both ways, so a field renamed, dropped, added as
// required or retyped fails the root typecheck (`tsc -b` includes tests/**).

declare const exported: Recipe
declare const spec: SpecRecipe
declare const exportedValue: RecipeValue
declare const specValue: SpecRecipeValue

export const exportedRecipeIsSpecShape: SpecRecipe = exported
export const specRecipeIsExportedShape: Recipe = spec
export const exportedValueIsSpecShape: SpecRecipeValue = exportedValue
export const specValueIsExportedShape: RecipeValue = specValue
