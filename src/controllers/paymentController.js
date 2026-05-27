import * as svc from '../services/paymentService.js';
  export const createOrder  = async (req, res) => { try { res.json(await svc.createOrder(req.body)); } catch(e) { res.status(500).json({ message: e.message }); } };
  export const verifyPayment = async (req, res) => {
    try {
      const ok = svc.verifyPayment(req.body);
      if (!ok) return res.status(400).json({ message: 'Payment verification failed' });
      res.json({ message: 'Payment verified', success: true });
    } catch(e) { res.status(500).json({ message: e.message }); }
  };
  