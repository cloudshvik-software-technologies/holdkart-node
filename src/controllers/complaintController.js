import * as svc from '../services/complaintService.js';
  export const submitComplaint = async (req, res) => { try { res.status(201).json(await svc.submitComplaint({ ...req.body, customerId: req.customer.id })); } catch(e) { res.status(500).json({ message: e.message }); } };
  export const listComplaints  = async (req, res) => { try { res.json(await svc.listComplaints(req.customer.id)); } catch(e) { res.status(500).json({ message: e.message }); } };
  