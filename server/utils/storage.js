/**
 * Image storage with three interchangeable providers:
 *
 *   s3          - AWS S3 object storage. Used automatically when S3_BUCKET_NAME
 *                 (or AWS_S3_BUCKET) is configured. Uses the AWS SDK v3 client
 *                 with automatic EC2 IAM role / IMDSv2 resolution or credentials.
 *   cloudinary  - used when CLOUDINARY_URL (or CLOUDINARY_CLOUD_NAME /
 *                 CLOUDINARY_API_KEY / CLOUDINARY_API_SECRET) is configured.
 *   local       - development fallback that writes to server/uploads and serves /uploads/*.
 *
 * Listings only ever store URLs (never base64) so MongoDB documents stay small.
 */
import crypto from 'crypto'
import fs from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import { v2 as cloudinary } from 'cloudinary'
import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
export const LOCAL_UPLOAD_DIR = process.env.LOCAL_UPLOAD_DIR || path.join(__dirname, '..', 'uploads')
export const MAX_IMAGE_BYTES = Number(process.env.MAX_IMAGE_MB || 5) * 1024 * 1024
export const MAX_IMAGES_PER_LISTING = 6

let cloudinaryConfiguredFlag = false
let s3ClientInstance = null

export function s3BucketName() {
  return process.env.S3_BUCKET_NAME || process.env.AWS_S3_BUCKET || ''
}

export function s3Region() {
  return process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'ap-southeast-2'
}

export function s3Configured() {
  return Boolean(s3BucketName())
}

export function cloudinaryConfigured() {
  return Boolean(
    process.env.CLOUDINARY_URL ||
      (process.env.CLOUDINARY_CLOUD_NAME && process.env.CLOUDINARY_API_KEY && process.env.CLOUDINARY_API_SECRET)
  )
}

export function storageProvider() {
  const explicit = (process.env.STORAGE_PROVIDER || '').toLowerCase()
  if (explicit === 's3' && s3Configured()) return 's3'
  if (explicit === 'cloudinary' && cloudinaryConfigured()) return 'cloudinary'
  if (explicit === 'local') return 'local'

  if (s3Configured()) return 's3'
  if (cloudinaryConfigured()) return 'cloudinary'
  return 'local'
}

export function getS3Client() {
  if (!s3ClientInstance) {
    const config = {
      region: s3Region(),
    }
    if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
      config.credentials = {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
        ...(process.env.AWS_SESSION_TOKEN ? { sessionToken: process.env.AWS_SESSION_TOKEN } : {}),
      }
    }
    if (process.env.S3_ENDPOINT) {
      config.endpoint = process.env.S3_ENDPOINT
    }
    if (process.env.S3_FORCE_PATH_STYLE === 'true') {
      config.forcePathStyle = true
    }
    s3ClientInstance = new S3Client(config)
  }
  return s3ClientInstance
}

export function setS3Client(client) {
  s3ClientInstance = client
}

export function resetS3Client() {
  s3ClientInstance = null
}

function ensureCloudinary() {
  if (cloudinaryConfiguredFlag) return
  if (!process.env.CLOUDINARY_URL) {
    cloudinary.config({
      cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
      api_key: process.env.CLOUDINARY_API_KEY,
      api_secret: process.env.CLOUDINARY_API_SECRET,
    })
  }
  cloudinary.config({ secure: true })
  cloudinaryConfiguredFlag = true
}

/** Identify the real image type from magic bytes (never trust the client's MIME type or filename). */
export function sniffImage(buf) {
  if (!buf || buf.length < 12) return null
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' }
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', ext: 'png' }
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return { mime: 'image/webp', ext: 'webp' }
  if (buf.subarray(0, 4).toString('ascii') === 'GIF8') return { mime: 'image/gif', ext: 'gif' }
  return null
}

function uploadToCloudinary(buffer, folder) {
  ensureCloudinary()
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      {
        folder,
        resource_type: 'image',
        transformation: [{ width: 1600, height: 1600, crop: 'limit', quality: 'auto' }],
        overwrite: false,
        unique_filename: true,
      },
      (err, result) => (err ? reject(err) : resolve(result))
    )
    stream.end(buffer)
  })
}

export function publicBaseUrl() {
  return (process.env.PUBLIC_API_URL || '').replace(/\/$/, '')
}

export async function getS3ObjectStream(key) {
  const client = getS3Client()
  return client.send(
    new GetObjectCommand({
      Bucket: s3BucketName(),
      Key: key,
    })
  )
}

/** @returns {{url, publicId, provider, width, height, bytes, format}} */
export async function saveImage(buffer, { ownerId, kind }) {
  const provider = storageProvider()
  const type = sniffImage(buffer)
  const ext = type?.ext || 'jpg'
  const mime = type?.mime || 'image/jpeg'

  if (provider === 's3') {
    const bucket = s3BucketName()
    const region = s3Region()
    const key = `${kind || 'listings'}/${ownerId}/${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`
    const client = getS3Client()

    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: buffer,
        ContentType: mime,
        CacheControl: 'public, max-age=31536000',
      })
    )

    const prefix = (process.env.S3_PUBLIC_URL_PREFIX || '').replace(/\/$/, '')
    const directUrl = prefix
      ? `${prefix}/${key}`
      : `https://${bucket}.s3.${region}.amazonaws.com/${key}`

    const url = process.env.USE_S3_PROXY === 'true'
      ? `${publicBaseUrl()}/api/uploads/s3/${key}`
      : directUrl

    return {
      url,
      publicId: key,
      provider: 's3',
      width: 0,
      height: 0,
      bytes: buffer.length,
      format: ext,
    }
  }

  if (provider === 'cloudinary') {
    const folder = `${process.env.CLOUDINARY_FOLDER || 'campus-marketplace'}/${kind || 'listings'}`
    const r = await uploadToCloudinary(buffer, folder)
    return {
      url: r.secure_url,
      publicId: r.public_id,
      provider: 'cloudinary',
      width: r.width,
      height: r.height,
      bytes: r.bytes,
      format: r.format,
    }
  }

  const dir = path.join(LOCAL_UPLOAD_DIR, String(ownerId))
  await fs.mkdir(dir, { recursive: true })
  const name = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}.${ext}`
  await fs.writeFile(path.join(dir, name), buffer)
  return {
    url: `${publicBaseUrl()}/uploads/${ownerId}/${name}`,
    publicId: `${ownerId}/${name}`,
    provider: 'local',
    width: 0,
    height: 0,
    bytes: buffer.length,
    format: ext,
  }
}

export async function removeImage({ publicId, provider }) {
  if (!publicId) return false
  try {
    if (provider === 's3') {
      const client = getS3Client()
      await client.send(
        new DeleteObjectCommand({
          Bucket: s3BucketName(),
          Key: publicId,
        })
      )
      return true
    }
    if (provider === 'cloudinary') {
      ensureCloudinary()
      const r = await cloudinary.uploader.destroy(publicId, { resource_type: 'image', invalidate: true })
      return r.result === 'ok' || r.result === 'not found'
    }
    const safe = path.normalize(publicId).replace(/^(\.\.(\/|\\|$))+/, '')
    await fs.unlink(path.join(LOCAL_UPLOAD_DIR, safe))
    return true
  } catch (err) {
    if (err.code === 'ENOENT') return true
    console.warn('removeImage failed', publicId, err.message)
    return false
  }
}
