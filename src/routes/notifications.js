import { Router } from 'express';
  import * as c from '../controllers/notificationController.js';
  import { authenticate } from '../middleware/auth.js';
  const r = Router();
  r.use(authenticate);
  r.get('/list',       c.getNotifications);
  r.get('/unread-count', c.getUnreadCount);
  r.put('/mark-read',  c.markRead);
  export default r;
  