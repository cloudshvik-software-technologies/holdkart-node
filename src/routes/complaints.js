import { Router } from 'express';
  import * as c from '../controllers/complaintController.js';
  import { authenticate } from '../middleware/auth.js';
  const r = Router();
  r.use(authenticate);
  r.post('/submit', c.submitComplaint);
  r.get('/list',    c.listComplaints);
  export default r;
  