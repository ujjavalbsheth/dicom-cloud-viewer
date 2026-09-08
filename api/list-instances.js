import { S3Client, ListObjectsV2Command, GetObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
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

  const studyUID = req.query.studyUID;
  if (!studyUID) {
    return res.status(400).json({ error: 'studyUID required' });
  }

  try {
    const safe = (s) => String(s).replace(/[^a-zA-Z0-9.\-_]/g, '_').slice(0, 256);
    const safeStudy = safe(studyUID);

    const result = await s3.send(
      new ListObjectsV2Command({
        Bucket: BUCKET,
        Prefix: `studies/${safeStudy}/`,
      })
    );

    // Sort by key (numeric prefix ensures correct slice order)
    const objects = (result.Contents || []).sort((a, b) => a.Key.localeCompare(b.Key));

    if (objects.length === 0) {
      return res.status(404).json({ error: 'Study not found' });
    }

    // Sign GET URLs for each instance (30 min expiry — plenty for one viewing session)
    const instances = await Promise.all(
      objects.map(async (obj) => {
        const cmd = new GetObjectCommand({ Bucket: BUCKET, Key: obj.Key });
        const url = await getSignedUrl(s3, cmd, { expiresIn: 1800 });
        return { key: obj.Key, url, size: obj.Size };
      })
    );

    // Fetch study description from first file's metadata
    let description = null;
    try {
      const head = await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: objects[0].Key }));
      const desc = head.Metadata?.['study-description'];
      if (desc) {
        try {
          description = decodeURIComponent(desc);
        } catch (e) {}
      }
    } catch (err) {}

    return res.status(200).json({ instances, description, count: instances.length });
  } catch (err) {
    console.error('list-instances error:', err);
    return res.status(500).json({ error: err.message || 'Internal error' });
  }
}
