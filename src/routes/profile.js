import { Router } from 'express';
import * as c from '../controllers/profileController.js';
import { authenticate } from '../middleware/auth.js';
import { uploadProfileImg } from '../middleware/upload.js';

const r = Router();


r.use(authenticate);
r.get('/get',           c.getProfile);
r.put('/update',        c.updateProfile);
r.post('/upload-image', uploadProfileImg, c.uploadProfileImage);
r.delete('/delete-image', c.deleteProfileImage);
r.get('/deactivation-info',  c.getDeactivationInfo);
r.get('/deactivation-check', c.getDeactivationWarnings);
r.post('/deactivate',    c.deactivateAccount);
r.post('/reactivate',    c.reactivateAccount);

export default r;