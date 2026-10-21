import { HeadBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { boundedHealthCheck, type HealthReport, type MediaStorage } from '@nymbalhq/types'

/** Where the URL of an object starts, and where its key starts in the bucket. */
export interface S3ObjectUrlOptions {
  bucket: string
  /** `us-east-1` when not given. */
  region?: string
  /** An S3-compatible API (MinIO, R2); its objects are served path-style under it. */
  endpoint?: string
  /** Prepended to every key, its edge slashes trimmed; none when empty. */
  prefix?: string
  /** Where the bucket's objects are served from (a CDN), when not the bucket's own URL. */
  publicUrl?: string
}

export interface S3MediaStorageOptions extends S3ObjectUrlOptions {
  /** True by default when an endpoint is set: an S3-compatible server rarely has per-bucket hostnames. */
  forcePathStyle?: boolean
  /** For tests only: a store gets its credentials from the AWS SDK's default chain. */
  credentials?: { accessKeyId: string; secretAccessKey: string }
}

export const S3_MEDIA_CAPABILITIES: readonly string[] = ['put']

export const DEFAULT_S3_REGION = 'us-east-1'

const trimTrailingSlashes = (s: string): string => s.replace(/\/+$/, '')

/** The object's key in the bucket. Only the prefix is normalised: the key stays verbatim, so distinct keys stay distinct objects. */
function objectKey(prefix: string | undefined, key: string): string {
  const trimmed = (prefix ?? '').replace(/^\/+|\/+$/g, '')
  return trimmed === '' ? key : `${trimmed}/${key}`
}

function baseUrl(options: S3ObjectUrlOptions): string {
  if (options.publicUrl !== undefined) return trimTrailingSlashes(options.publicUrl)
  if (options.endpoint !== undefined) {
    return `${trimTrailingSlashes(options.endpoint)}/${options.bucket}`
  }
  return `https://${options.bucket}.s3.${options.region ?? DEFAULT_S3_REGION}.amazonaws.com`
}

/** The public URL of the object stored under `key`: the base, then each segment of the object key percent-encoded. */
export function s3ObjectUrl(options: S3ObjectUrlOptions, key: string): string {
  const path = objectKey(options.prefix, key).split('/').map(encodeURIComponent).join('/')
  return `${baseUrl(options)}/${path}`
}

/**
 * Media stored as objects in a bucket the operator owns: it never creates buckets or sets policies, so the bucket (or
 * the `publicUrl` in front of it) must already serve its objects publicly.
 */
export function createS3MediaStorage(options: S3MediaStorageOptions): MediaStorage {
  const client = new S3Client({
    region: options.region ?? DEFAULT_S3_REGION,
    forcePathStyle: options.forcePathStyle ?? options.endpoint !== undefined,
    ...(options.endpoint !== undefined && { endpoint: options.endpoint }),
    ...(options.credentials !== undefined && { credentials: options.credentials }),
  })
  return {
    capabilities: () => S3_MEDIA_CAPABILITIES,
    async put(key, body, contentType) {
      await client.send(
        new PutObjectCommand({
          Bucket: options.bucket,
          Key: objectKey(options.prefix, key),
          Body: body,
          ContentType: contentType,
        }),
      )
      return { url: s3ObjectUrl(options, key) }
    },
    // HeadBucket reads the bucket's existence and our access to it; aborted at the bound, retries included.
    healthCheck(): Promise<HealthReport> {
      return boundedHealthCheck(
        async (signal) => {
          await client.send(new HeadBucketCommand({ Bucket: options.bucket }), {
            abortSignal: signal,
          })
          return { status: 'healthy', detail: options.bucket }
        },
        {
          redact: [
            options.credentials?.accessKeyId ?? '',
            options.credentials?.secretAccessKey ?? '',
          ],
        },
      )
    },
  }
}
