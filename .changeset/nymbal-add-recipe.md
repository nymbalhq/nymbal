---
'nymbal': minor
'@nymbalhq/types': minor
'@nymbalhq/platform': minor
'@nymbalhq/doc-store-redis': minor
'@nymbalhq/media-s3': minor
'@nymbalhq/adapter-stripe': minor
---

`nymbal add <recipe>` puts a scaffolded store on a service in one command: `redis`, `postgres`, `s3` or `stripe`. It
installs the packages with the project's package manager, writes the slot values into `nymbal.config.ts`, appends the
variables the service reads to `.env.example`, checks the result loads, and prints what is left to do (each required
variable still unset is listed as `set NAME in .env`).

- The edit goes through the config's AST, so comments, order and every other key stay as they were. Secrets are written
  only as `env('NAME')` calls, and `env` is added to the `@nymbalhq/config` import when needed. The edited config is
  loaded before it is written, with the values in `.env` applied as `nymbal dev` applies them and a placeholder for
  every variable still unset that an `env()` call with no default names. A secret not yet set never blocks an add, and
  a default or a `.env` value is validated as it will run. Nothing connects to the service.
- Re-running a recipe is a no-op. A value the developer chose (not the scaffold's default) is a conflict that changes
  nothing and names the path and both values; `--force` overwrites it. `--dry-run` prints the config change, the
  `.env.example` lines and the install line. `--no-install` fails with the install line when a package is missing.
- Each recipe is data in the package it belongs to, `recipes/<name>.json` in the `Recipe` shape that `@nymbalhq/types`
  now exports: `@nymbalhq/doc-store-redis` ships `redis`, `@nymbalhq/media-s3` ships `s3`, `@nymbalhq/adapter-stripe`
  ships `stripe` and `@nymbalhq/platform` ships `postgres`. Each exports `./recipes/*`.
- `@nymbalhq/platform` exports `installLine(packages, env, cwd)`, the install command the adapter loader names for a
  missing package.
