import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export const maxDuration = 30;

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});

const BUCKET = process.env.R2_BUCKET;

export default async function handler(req, res) {
  if (req.headers['x-access-password'] !== process.env.ACCESS_PASSWORD) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const {
      studyUID,
      seriesUID,
      instanceUID,
      instanceNumber,
      modality,
      studyDescription,
    } = req.body || {};

    if (!studyUID || !instanceUID) {
      return res.status(400).json({ error: 'studyUID and instanceUID are required' });
    }

    const safe = (s) => String(s).replace(/[^a-zA-Z0-9.\-_]/g, '_').slice(0, 256);

    const safeStudy = safe(studyUID);
    const safeSeries = safe(seriesUID || 'default-series');
    const safeInstance = safe(instanceUID);
    const num = String(instanceNumber || 0).padStart(6, '0');

    const key = `studies/${safeStudy}/${safeSeries}/${num}-${safeInstance}.dcm`;

    const command = new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      ContentType: 'application/dicom',
      Metadata: {
        modality: safe(modality || ''),
        'study-description': encodeURIComponent(String(studyDescription || '').slice(0, 256)),
      },
    });

    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 900 });

    return res.status(200).json({ uploadUrl, key });
  } catch (err) {
    console.error('upload-url error:', err);
    return res.status(500).json({ error: err.message || 'Internal error' });
  }
}
