import { Router } from 'express';
import * as c from '../controllers/campaignController.js';
import { authenticate } from '../middleware/auth.js';
const r = Router();
r.get('/list',    c.listCampaigns);
r.post('/join',   authenticate, c.joinCampaign);
r.post('/leave',  authenticate, c.leaveCampaign);
r.get('/mine',    authenticate, c.getMyCampaigns);
export default r;