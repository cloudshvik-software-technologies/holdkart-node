import * as svc from '../services/campaignService.js';
const s = (e) => e.status || 500;
export const listCampaigns     = async (req, res) => { try { res.json(await svc.listCampaigns()); } catch(e) { res.status(500).json({ message: e.message }); } };
export const joinCampaign      = async (req, res) => { try { res.json(await svc.joinCampaign({ ...req.body, customerId: req.customer.id })); } catch(e) { res.status(s(e)).json({ message: e.message }); } };
export const leaveCampaign     = async (req, res) => { try { res.json(await svc.leaveCampaign({ ...req.body, customerId: req.customer.id })); } catch(e) { res.status(s(e)).json({ message: e.message }); } };
export const getMyCampaigns    = async (req, res) => { try { res.json(await svc.getMyCampaigns(req.customer.id)); } catch(e) { res.status(500).json({ message: e.message }); } };
export const startOrJoinCampaign = async (req, res) => { try { res.json(await svc.startOrJoinCampaign({ ...req.body, customerId: req.customer.id })); } catch(e) { res.status(s(e)).json({ message: e.message }); } };
export const addToDeal          = async (req, res) => { try { res.json(await svc.addToDeal({ ...req.body, customerId: req.customer.id })); } catch(e) { res.status(s(e)).json({ message: e.message }); } };
export const getCampaignById    = async (req, res) => { try { const id = parseInt(req.params.id, 10); if (!id) return res.status(400).json({ message: 'Invalid campaign id' }); res.json(await svc.getCampaignById(id)); } catch(e) { res.status(s(e)).json({ message: e.message }); } };