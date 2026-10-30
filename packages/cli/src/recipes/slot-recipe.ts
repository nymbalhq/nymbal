import { slotFolder } from '@nymbalhq/config'
import type { AdapterSetting, Recipe, Slot } from '@nymbalhq/types'

const INFRASTRUCTURE: ReadonlySet<Slot> = new Set(['documentStore', 'eventBus', 'media'])

/** Where nymbal.config.ts holds a slot's choice: `commerce.payments`, `infrastructure.media`, or `security`. */
export function slotPath(slot: Slot): string {
  if (slot === 'security') return 'security'
  return INFRASTRUCTURE.has(slot) ? `infrastructure.${slot}` : `commerce.${slot}`
}

/** The slot (or other top-level key) a config path sets: `infrastructure.eventBus` sets eventBus. */
function slotAt(path: string): string {
  const [top, key] = path.split('.')
  return (top === 'commerce' || top === 'infrastructure') && key !== undefined ? key : top!
}

/** Every slot `recipe` sets, each once, in its order, as the CLI prints it (`document-store`). */
export function slotsSetBy(recipe: Recipe): string[] {
  return [...new Set(recipe.set.map(({ path }) => slotFolder(slotAt(path) as Slot)))]
}

/** Whether every path `recipe` sets lies under `slot`'s own path. */
export function setsOnly(recipe: Recipe, slot: Slot): boolean {
  const base = slotPath(slot)
  return recipe.set.every(({ path }) => path === base || path.startsWith(`${base}.`))
}

/**
 * The recipe `nymbal add` applies for a provider whose package ships none: the slot set to the provider (and the
 * package, when it is not the convention's), one `.env.example` line per setting read from a variable, and the
 * settings with no variable named as the admin's.
 */
export function slotRecipe(opts: {
  name: string
  slot: Slot
  provider: string
  package?: string | undefined
  install: string[]
  settings: readonly AdapterSetting[]
}): Recipe {
  const { slot, provider, settings } = opts
  const set: Recipe['set'] =
    slot === 'security'
      ? [
          { path: 'security.adapter', value: provider },
          ...(opts.package === undefined
            ? []
            : [{ path: 'security.package', value: opts.package }]),
        ]
      : [
          {
            path: slotPath(slot),
            value: { provider, ...(opts.package !== undefined && { package: opts.package }) },
          },
        ]
  const from = opts.package === undefined ? '' : ` from ${opts.package}`
  return {
    name: opts.name,
    summary: `${slotFolder(slot)} is ${provider}${from}`,
    install: opts.install,
    set,
    env: settings.flatMap((s) =>
      s.env === undefined
        ? []
        : [{ name: s.env, example: '', required: s.optional !== true, comment: s.label }],
    ),
    next: [
      ...settings
        .filter((s) => s.env === undefined)
        .map((s) => `set ${s.path} in the admin's Settings (${s.label})`),
      ...(INFRASTRUCTURE.has(slot) && settings.length === 0
        ? [`run nymbal doctor to check ${slotFolder(slot)} on ${provider}`]
        : []),
    ],
  }
}
