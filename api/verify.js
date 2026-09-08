// Serverless function: verify the app password.
// Runs on Vercel as a Node function. Reads ACCESS_PASSWORD env var.

export default function handler(req, res) {
  const provided = req.headers['x-access-password'];
  const expected = process.env.ACCESS_PASSWORD;

  if (!expected) {
    return res.status(500).json({ error: 'ACCESS_PASSWORD env var not set' });
  }

  if (provided !== expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  return res.status(200).json({ ok: true });
}
