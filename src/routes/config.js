import { Router } from 'express';
import db from '../config/db.js';

const r = Router();

// Public — no auth. Read-only, non-sensitive; lets checkout show the real,
// currently-configured platform fee instead of a hardcoded number that
// silently goes stale whenever admin changes it in Commission Settings.
r.get('/platform-fee', async (req, res) => {
  try {
    const [rows] = await db.query(`SELECT value FROM platform_settings WHERE key = 'platform_fee'`);
    res.json({ platformFee: rows.length ? Number(rows[0].value) : 5 });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

r.get('/return-video-threshold', async (req, res) => {
  try {
    const [rows] = await db.query(`SELECT value FROM platform_settings WHERE key = 'return_video_threshold'`);
    res.json({ threshold: rows.length ? Number(rows[0].value) : 5000 });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

export default r;