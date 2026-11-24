// Reads: compose.yaml
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// Docker makes an anonymous volume for every path an image declares as a VOLUME that the container does not mount,
// and `docker compose down` without `-v` leaves it behind: one per container, on every bring-up. So each such path of
// each compose service is on tmpfs or on a named volume. compose.yaml is read through `docker compose config`, which
// resolves anchors, profiles and short syntax as `up` does.

const REPO = fileURLToPath(new URL('../../', import.meta.url))

// The VOLUME lines of each image reference compose.yaml pins (tag and digest as written), from their image configs
// (2026-11-23). VOLUME lines change between versions (postgres:18 declares /var/lib/postgresql, not .../data), so a
// reference not listed here, a bumped tag included, fails the first test: read the new image's VOLUME paths (`docker
// buildx imagetools inspect <image> --format '{{json .Image}}'`, which pulls nothing) and list them under it.
const IMAGE_VOLUMES: Record<string, string[]> = {
  'postgres:16-alpine': ['/var/lib/postgresql/data'],
  'redis:7-alpine': ['/data'],
  'axllent/mailpit:v1.22.0': [],
  'pgsty/minio:RELEASE.2026-08-04T00-00-00Z@sha256:b6bfe7239bfc83fb90d31612d9704d86039dd714f7904b3f1ad68f211e602372':
    ['/data'],
  'pgsty/mc:RELEASE.2026-10-18T00-00-00Z@sha256:6ecdaec70bc5e8cf9d0e9a70c190f3beb1c83f11617ff4333f1fcd71ab1daf18':
    [],
  'mariadb:11.8@sha256:c4124d1afa875e47f2892edf26b482fa54f796e2f342d3717a04ca091a22a9bd': [
    '/var/lib/mysql',
  ],
  'wordpress:7.1-php8.4-apache@sha256:543d2b75f287c76f387cd17dcf2ca5e69745a1c30b754e32414a5e1ef5b8da87':
    ['/var/www/html'],
  'wordpress:cli-2.12-php8.4@sha256:37b7e3ed9b537788756f9b5c6dd8ec7c3f3053ee707abc67c776e453ba8f9e55':
    ['/var/www/html'],
}

type Mount = { type: string; source?: string; target: string }
type Service = { image: string; tmpfs?: string[]; volumes?: Mount[] }
type Config = { services: Record<string, Service>; volumes?: Record<string, unknown> }

const config = JSON.parse(
  execFileSync('docker', ['compose', '--profile', '*', 'config', '--format', 'json'], {
    cwd: REPO,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }),
) as Config
const named = new Set(Object.keys(config.volumes ?? {}))
const services = Object.entries(config.services)

/** The paths a service mounts that leave nothing behind: tmpfs, or a volume the file names at the top level. */
function kept(service: Service): Set<string> {
  const out = new Set(service.tmpfs ?? [])
  for (const mount of service.volumes ?? []) {
    if (mount.type === 'tmpfs') out.add(mount.target)
    if (mount.type === 'volume' && mount.source !== undefined && named.has(mount.source)) {
      out.add(mount.target)
    }
  }
  return out
}

describe('compose services leave no anonymous volume behind', () => {
  it('every service image has its VOLUME paths listed', () => {
    const images = services.map(([, service]) => service.image)
    expect(images.filter((image) => image in IMAGE_VOLUMES)).toEqual(images)
  })

  it.each(services)(
    '%s mounts each path its image declares on tmpfs or a named volume',
    (_, service) => {
      const declared = IMAGE_VOLUMES[service.image] ?? []
      const mounted = kept(service)
      expect(declared.filter((path) => mounted.has(path))).toEqual(declared)
    },
  )
})
