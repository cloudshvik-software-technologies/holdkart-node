import * as authService from '../services/authService.js';
  const status = (err) => err.status || 500;
  export const register       = async (req, res) => { try { res.status(201).json(await authService.register(req.body)); } catch(e) { res.status(status(e)).json({ message: e.message }); } };
  export const login          = async (req, res) => { try { res.json(await authService.login(req.body)); } catch(e) { res.status(status(e)).json({ message: e.message }); } };
  export const refresh        = async (req, res) => { try { res.json(await authService.refresh(req.body)); } catch(e) { res.status(status(e)).json({ message: e.message }); } };
  export const forgotPassword = async (req, res) => { try { res.json(await authService.forgotPassword(req.body)); } catch(e) { res.status(status(e)).json({ message: e.message }); } };
  export const resetPassword  = async (req, res) => { try { res.json(await authService.resetPassword(req.body)); } catch(e) { res.status(status(e)).json({ message: e.message }); } };
  export const logout         = async (req, res) => { try { res.json(await authService.logout(req.body)); } catch(e) { res.status(status(e)).json({ message: e.message }); } };
  