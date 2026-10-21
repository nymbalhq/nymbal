import { ConfigError, type AdapterContext, type MediaStorage } from '@nymbalhq/types'
import { createS3MediaStorage, type S3MediaStorageOptions } from './s3-media-storage.js'

export {
  createS3MediaStorage,
  DEFAULT_S3_REGION,
  S3_MEDIA_CAPABILITIES,
  s3ObjectUrl,
  type S3MediaStorageOptions,
  type S3ObjectUrlOptions,
} from './s3-media-storage.js'

const optionalString = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined

/**
 * The kernel's entry: `infrastructure.media: 's3'`, with the `s3` block as the platform resolved it (its environment
 * fallbacks and defaults applied). Credentials are never in it: the AWS SDK's default chain provides them.
 */
export function createAdapter(ctx: AdapterContext): MediaStorage {
  if (ctx.slot !== 'media') {
    throw new ConfigError(`@nymbalhq/media-s3 serves media, not ${ctx.slot}`, {
      code: 'adapter.wrong_slot',
      context: { slot: ctx.slot },
    })
  }
  const bucket = optionalString(ctx.config['bucket'])
  if (bucket === undefined) {
    throw new ConfigError('@nymbalhq/media-s3 needs a bucket', {
      code: 'config.invalid',
      context: { slot: ctx.slot },
    })
  }
  const options: S3MediaStorageOptions = { bucket }
  for (const field of ['region', 'endpoint', 'prefix', 'publicUrl'] as const) {
    const value = optionalString(ctx.config[field])
    if (value !== undefined) options[field] = value
  }
  if (typeof ctx.config['forcePathStyle'] === 'boolean') {
    options.forcePathStyle = ctx.config['forcePathStyle']
  }
  return createS3MediaStorage(options)
}
