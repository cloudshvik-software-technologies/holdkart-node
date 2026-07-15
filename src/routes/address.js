import { Router } from 'express';
import * as c from '../controllers/addressController.js';
import { authenticate } from '../middleware/auth.js';

const r = Router();

r.use(authenticate);
r.get('/',              c.listAddresses);
r.post('/',              c.createAddress);
r.put('/:id',            c.updateAddress);
r.delete('/:id',          c.deleteAddress);
r.put('/:id/set-default', c.setDefaultAddress);

export default r;