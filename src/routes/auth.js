import { Router } from 'express';
  import * as c from '../controllers/authController.js';
  const r = Router();
  r.post('/register', c.register);
  r.post('/login',    c.login);
  r.post('/refresh',  c.refresh);
  r.post('/forgot-password', c.forgotPassword);
  r.post('/reset-password',  c.resetPassword);
  r.post('/logout',   c.logout);
  export default r;
  