import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { findConfigFile, loadConfig, type LoadedConfig } from '@nymbalhq/config'

/**
 * Loads `<projectRoot>/.env` into the process environment, then the project's config, so `env()` calls in
 * `nymbal.config.ts` see it. A variable already set in the environment is kept: `process.loadEnvFile` never overrides.
 */
export async function loadProject(startDir: string = process.cwd()): Promise<LoadedConfig> {
  const configPath = findConfigFile(startDir)
  if (configPath) {
    const envFile = resolve(dirname(configPath), '.env')
    if (existsSync(envFile)) process.loadEnvFile(envFile)
  }
  return loadConfig(startDir)
}
