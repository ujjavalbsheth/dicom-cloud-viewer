import { S3Client, ListObjectsV2Command, HeadObjectCommand } from '@aws-sdk/client-s3';

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

  try {
    const result = await s3.send(
      new ListObjectsV2Command({
        Bucket: BUCKET,
        Prefix: 'studies/',
      })
    );

    const studies = {};
    for (const obj of result.Contents || []) {
      const parts = obj.Key.split('/');
      if (parts.length < 4) continue;
      const studyUID = parts[1];

      if (!studies[studyUID]) {
        studies[studyUID] = {
          studyUID,
          fileCount: 0,
          totalSize: 0,
          modality: null,
          description: null,
          firstKey: obj.Key,
        };
      }
      studies[studyUID].fileCount++;
      studies[studyUID].totalSize += obj.Size || 0;
    }

    await Promise.all(
      Object.values(studies).map(async (study) => {
        try {
          const head = await s3.send(
            new HeadObjectCommand({ Bucket: BUCKET, Key: study.firstKey })
          );
          study.modality = head.Metadata?.modality || null;
          const desc = head.Metadata?.['study-description'];
          if (desc) {
            try {
              study.description = decodeURIComponent(desc);
            } catch (e) {}
          }
        } catch (err) {}
        delete study.firstKey;
      })
    );

    const studiesArr = Object.values(studies).sort((a, b) =>
      (a.description || a.studyUID).localeCompare(b.description || b.studyUID)
    );

    return res.status(200).json({ studies: studiesArr });
  } catch (err) {
    console.error('list-studies error:', err);
    return res.status(500).json({ error: err.message || 'Internal error' });
  }
}
