export interface DockerfileOptions {
  /** package.json's `packageManager`, `<name>@<version>`. */
  packageManager: string
  nodeVersion: string
  template: 'astro' | 'nextjs'
}

const FROZEN_INSTALL: Record<string, string> = {
  npm: 'npm ci',
  pnpm: 'pnpm install --frozen-lockfile',
  yarn: 'yarn install --immutable',
  bun: 'bun install --frozen-lockfile',
}

/** The manager and version `packageManager` records, or an error naming what it accepts. */
export function parsePackageManager(packageManager: string): { name: string; version: string } {
  const match = /^(npm|pnpm|yarn|bun)@(\d+\.\d+\.\d+[^\s+]*)/.exec(packageManager.trim())
  if (!match) {
    throw new Error(
      `package.json "packageManager" must be npm, pnpm, yarn or bun at a version, such as "pnpm@10.18.0"`,
    )
  }
  return { name: match[1]!, version: match[2]! }
}

/**
 * The store's image: installed with the manager and lockfile the project records, built, then run on the same Node as
 * a non-root user with `nymbal start` as PID 1, so the platform's SIGTERM reaches it.
 */
export function renderDockerfile(options: DockerfileOptions): string {
  const { name, version } = parsePackageManager(options.packageManager)
  // Node 25 and later ship no corepack, and npm's `yarn` package stops at 1.x.
  const manager =
    name === 'bun'
      ? `RUN npm install -g bun@${version}`
      : 'RUN npm install -g corepack@0.36.0 && corepack enable'
  // Yarn 2+ defaults to Plug'n'Play, which leaves no node_modules/nymbal/bin/nymbal.mjs for CMD.
  const berry = name === 'yarn' && Number(version.split('.')[0]) >= 2
  return [
    `ARG NODE_VERSION=${options.nodeVersion}`,
    '',
    'FROM node:${NODE_VERSION}-slim AS build',
    'ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0',
    'WORKDIR /app',
    // better-sqlite3 compiles from source when its prebuilt binary cannot be fetched for this Node and platform.
    'RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*',
    manager,
    'COPY . .',
    ...(berry
      ? [
          "RUN grep -q '^nodeLinker:' .yarnrc.yml 2>/dev/null || echo 'nodeLinker: node-modules' >> .yarnrc.yml",
        ]
      : []),
    `RUN ${FROZEN_INSTALL[name]}`,
    // An empty public API URL: the browser calls the origin that served the page.
    'RUN PUBLIC_NYMBAL_API_URL= NEXT_PUBLIC_NYMBAL_API_URL= node node_modules/nymbal/bin/nymbal.mjs build',
    '',
    'FROM node:${NODE_VERSION}-slim',
    'ENV NODE_ENV=production',
    'WORKDIR /app',
    'COPY --from=build --chown=node:node /app /app',
    'USER node',
    'EXPOSE 3001',
    'CMD ["node", "node_modules/nymbal/bin/nymbal.mjs", "start"]',
    '',
  ].join('\n')
}

/** What never enters the build context: secrets, host databases, installed and built output. */
export const DOCKERIGNORE = [
  '.env*',
  '**/.env*',
  '*.db',
  '*.db-*',
  '**/*.db',
  '**/*.db-*',
  'node_modules',
  '**/node_modules',
  'dist',
  '.astro',
  '.next',
  '.git',
  '',
].join('\n')
