import { PutObjectCommand } from '@aws-sdk/client-s3'
import { objectKey, s3Client, type S3ClientOptions } from './s3-media-storage.js'

export interface S3ObjectWriterOptions extends S3ClientOptions {
  bucket: string
  /** Prepended to every key, its edge slashes trimmed; none when empty. */
  prefix?: string
}

/** Writes whole objects; what it writes is read back only with credentials. */
export interface S3ObjectWriter {
  put(key: string, body: Uint8Array, contentType: string): Promise<void>
}

/**
 * Private objects in a bucket the operator owns, such as the event archive: unlike media storage it answers no URL,
 * and it sets no ACL, so an object is as private as its bucket. Never point it at the public media bucket.
 */
export function createS3ObjectWriter(options: S3ObjectWriterOptions): S3ObjectWriter {
  const client = s3Client(options)
  return {
    async put(key, body, contentType) {
      await client.send(
        new PutObjectCommand({
          Bucket: options.bucket,
          Key: objectKey(options.prefix, key),
          Body: body,
          ContentType: contentType,
        }),
      )
    },
  }
}
