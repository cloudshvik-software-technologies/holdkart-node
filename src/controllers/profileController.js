import * as svc from '../services/profileService.js';
import db from '../config/db.js';

export const getProfile = async (req, res) => {
  try {
    const p = await svc.getProfile(req.customer.id);
    if (!p) return res.status(404).json({ message: 'Profile not found' });
    res.json(p);
  } catch (e) {
    console.error('[profileController.getProfile] ERROR:', e.message);
    console.error(e.stack);
    res.status(500).json({
      message: 'Failed to load profile',
      detail:  e.message,
      hint:    'Check your Node terminal for the full error. Most likely cause: schema.sql has not been run yet, or the customer table is missing columns.',
    });
  }
};

export const updateProfile = async (req, res) => {
  try {
    res.json(await svc.updateProfile({ ...req.body, customerId: req.customer.id }));
  } catch (e) {
    console.error('[profileController.updateProfile] ERROR:', e.message);
    res.status(500).json({ message: e.message });
  }
};

export const uploadProfileImage = async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: 'No file provided' });
    res.json(await svc.uploadProfileImage({
      customerId: req.customer.id,
      imageUrl:   '/uploads/profiles/' + req.file.filename,
    }));
  } catch (e) {
    console.error('[profileController.uploadProfileImage] ERROR:', e.message);
    res.status(500).json({ message: e.message });
  }
};

export const deleteProfileImage = async (req, res) => {
  try {
    res.json(await svc.deleteProfileImage({ customerId: req.customer.id }));
  } catch (e) {
    console.error('[profileController.deleteProfileImage] ERROR:', e.message);
    res.status(500).json({ message: e.message });
  }
};
// Returns pending orders, active deals, and account status for the 3-step
// deactivation modal (step 2 — account info review).
export const getDeactivationInfo = async (req, res) => {
  try {
    res.json(await svc.getDeactivationInfo(req.customer.id));
  } catch (e) {
    console.error('[profileController.getDeactivationInfo] ERROR:', e.message);
    res.status(500).json({ message: e.message });
  }
};

// Pending orders / active deals shown to the customer before they confirm deactivation.
export const getDeactivationWarnings = async (req, res) => {
  try {
    res.json(await svc.getDeactivationWarnings(req.customer.id));
  } catch (e) {
    console.error('[profileController.getDeactivationWarnings] ERROR:', e.message);
    res.status(500).json({ message: e.message });
  }
};

// FLIPKART-STYLE DEACTIVATION: customer confirms with password; account is
// soft-deactivated (not deleted). Logging back in shows a locked screen
// with an explicit "Activate" button (see reactivateAccount below).
export const deactivateAccount = async (req, res) => {
  try {
    res.json(await svc.deactivateAccount({
      customerId: req.customer.id,
      password:   req.body.password,
      reason:     req.body.reason || '',
    }));
  } catch (e) {
    console.error('[profileController.deactivateAccount] ERROR:', e.message);
    res.status(e.status || 500).json({ message: e.message });
  }
};

export const reactivateAccount = async (req, res) => {
  try {
    res.json(await svc.reactivateAccount({ customerId: req.customer.id }));
  } catch (e) {
    console.error('[profileController.reactivateAccount] ERROR:', e.message);
    res.status(e.status || 500).json({ message: e.message });
  }
};

export const debugProfile = async (_req, res) => {
  const results = {};
  try {
    await db.query('SELECT 1');
    results.db_connection = 'OK';
  } catch (e) {
    results.db_connection = 'FAILED: ' + e.message;
  }
  try {
    const [rows] = await db.query('SHOW COLUMNS FROM customer');
    results.customer_columns = rows.map(r => r.Field);
  } catch (e) {
    results.customer_columns = 'FAILED: ' + e.message;
  }
  try {
    const [rows] = await db.query('SELECT COUNT(*) AS cnt FROM customer');
    results.customer_row_count = rows[0].cnt;
  } catch (e) {
    results.customer_row_count = 'FAILED: ' + e.message;
  }
  res.json(results);
};