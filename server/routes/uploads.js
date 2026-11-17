import crypto from 'crypto'
import { Router } from 'express'
import multer from 'multer'
import rateLimit from 'express-rate-limit'
import Upload from '../models/Upload.js'
import { requireAuth, requireVerified } from '../middleware/auth.js'
import {
  saveImage,
  removeImage,
  sniffImage,
  storageProvider,
  s3BucketName,
  s3Region,
  getS3ObjectStream,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_LISTING,
} from '../utils/storage.js'

const router = Router()
const MAX_PENDING_PER_USER = 30

const uploadLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many uploads. Please wait a few minutes.' },
})

const parser = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMAGE_BYTES, files: MAX_IMAGES_PER_LISTING },
  fileFilter: (_req, file, cb) => cb(null, /^image\//.test(file.mimetype)),
})

function serialize(u) {
  return { id: u._id.toString(), url: u.url, provider: u.provider, bytes: u.bytes, width: u.width, height: u.height }
}

router.get('/status', requireAuth, (_req, res) => {
  const provider = storageProvider()
  res.json({
    provider,
    durable: provider === 's3' || provider === 'cloudinary',
    bucket: provider === 's3' ? s3BucketName() : undefined,
    region: provider === 's3' ? s3Region() : undefined,
    maxFiles: MAX_IMAGES_PER_LISTING,
    maxMb: Math.round(MAX_IMAGE_BYTES / 1024 / 1024),
    note:
      provider === 's3'
        ? `Photos are stored securely in AWS S3 (${s3BucketName() || 'bucket'}).`
        : provider === 'cloudinary'
          ? 'Photos are stored in the cloud (Cloudinary).'
          : 'Cloud storage is not configured. Photos are saved on the server disk (development mode).',
  })
})

router.get('/s3/*', async (req, res) => {
  try {
    const key = req.params[0]
    if (!key) return res.status(404).send('Not found')
    const response = await getS3ObjectStream(key)
    if (response.ContentType) res.setHeader('Content-Type', response.ContentType)
    if (response.ContentLength) res.setHeader('Content-Length', response.ContentLength)
    res.setHeader('Cache-Control', 'public, max-age=31536000')
    response.Body.pipe(res)
  } catch (err) {
    if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
      return res.status(404).json({ error: 'Image not found in S3' })
    }
    res.status(500).json({ error: err.message })
  }
})

router.post('/images', requireAuth, requireVerified, uploadLimiter, (req, res) => {
  parser.array('images', MAX_IMAGES_PER_LISTING)(req, res, async (err) => {
    if (err) {
      const message =
        err.code === 'LIMIT_FILE_SIZE'
          ? `Each image must be under ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)} MB`
          : err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE'
            ? `You can upload at most ${MAX_IMAGES_PER_LISTING} images at a time`
            : err.message
      return res.status(400).json({ error: message })
    }
    try {
      const files = req.files || []
      if (!files.length) return res.status(400).json({ error: 'Attach at least one image (JPEG, PNG, WebP or GIF)' })

      const pending = await Upload.countDocuments({ ownerId: req.user._id, listingId: null })
      if (pending + files.length > MAX_PENDING_PER_USER) {
        return res.status(429).json({ error: 'Too many unused uploads. Publish or remove some photos first.' })
      }

      const saved = []
      const errors = []
      for (const file of files) {
        if (!sniffImage(file.buffer)) {
          errors.push({ name: file.originalname, error: 'Not a valid JPEG, PNG, WebP or GIF image' })
          continue
        }
        try {
          const asset = await saveImage(file.buffer, { ownerId: req.user._id, kind: 'listings' })
          const contentHash = crypto.createHash('sha256').update(file.buffer).digest('hex')
          const doc = await Upload.create({ ...asset, ownerId: req.user._id, contentHash })
          saved.push(serialize(doc))
        } catch (e) {
          console.error('image upload failed', e.message)
          errors.push({ name: file.originalname, error: 'Storage provider rejected the upload' })
        }
      }
      if (!saved.length) return res.status(errors.some((e) => /Storage/.test(e.error)) ? 502 : 400).json({ error: errors[0].error, errors })
      res.status(201).json({ images: saved, errors, provider: storageProvider() })
    } catch (e) {
      res.status(500).json({ error: e.message })
    }
  })
})

router.delete('/images/:id', requireAuth, requireVerified, async (req, res) => {
  try {
    const doc = await Upload.findById(req.params.id)
    if (!doc || String(doc.ownerId) !== String(req.user._id)) return res.status(404).json({ error: 'Image not found' })
    if (doc.listingId) return res.status(409).json({ error: 'This image belongs to a listing. Edit the listing to remove it.' })
    await removeImage({ publicId: doc.publicId, provider: doc.provider })
    await doc.deleteOne()
    res.json({ ok: true })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

export default router
