export {
  MULTI_SLOT_PAIRS,
  RECIPE_HOLDERS,
  isInstalled,
  isKnownRecipe,
  knownRecipes,
  multiSlotRecipe,
  packageRecipeFile,
  readRecipe,
  readRecipeFile,
  recipeFile,
  settingsEnv,
} from './holders.js'
export {
  SCAFFOLD_DEFAULTS,
  applyRecipeToConfig,
  envCalls,
  type AppliedRecipe,
  type EnvCall,
  type Conflict,
} from './config-edit.js'
export { appendRecipeEnv, missingEnv } from './env-example.js'
export { setsOnly, slotPath, slotRecipe, slotsSetBy } from './slot-recipe.js'
