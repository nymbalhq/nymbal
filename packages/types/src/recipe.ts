/**
 * A value a recipe writes into `nymbal.config.ts`. `{ env }` is written as `env('<name>')`, or
 * `env('<name>', '<default>')` when a default is given, so no secret ever lands in the file.
 */
export type RecipeValue =
  | string
  | boolean
  | number
  | { env: string; default?: string }
  | { [k: string]: RecipeValue }

/**
 * What `nymbal add <name>` does to a project: data shipped as `recipes/<name>.json` inside the package it belongs to.
 */
export interface Recipe {
  name: string
  summary: string
  /** npm packages to install, SDKs included; empty when the service is built in. */
  install: string[]
  /** Config paths and the values they take, e.g. `infrastructure.documentStore.provider` = `'redis'`. */
  set: Array<{ path: string; value: RecipeValue }>
  /** The variables the service reads, appended to `.env.example`; an optional one is written commented out. */
  env: Array<{ name: string; example: string; required: boolean; comment: string }>
  /** Lines printed after a successful add. */
  next: string[]
}
