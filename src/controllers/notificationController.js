import * as svc from '../services/notificationService.js';
  export const getNotifications = async (req, res) => { try { res.json(await svc.getNotifications(req.customer.id)); } catch(e) { res.status(500).json({ message: e.message }); } };
  export const markRead         = async (req, res) => { try { res.json(await svc.markRead({ customerId: req.customer.id, notificationId: req.body.notificationId })); } catch(e) { res.status(500).json({ message: e.message }); } };
  export const getUnreadCount   = async (req, res) => { try { res.json(await svc.getUnreadCount(req.customer.id)); } catch(e) { res.status(500).json({ message: e.message }); } };
  