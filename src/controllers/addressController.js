import * as svc from '../services/addressService.js';

export const listAddresses = async (req, res) => {
  try {
    res.json(await svc.listAddresses(req.customer.id));
  } catch (e) {
    console.error('[addressController.listAddresses] ERROR:', e.message);
    res.status(e.status || 500).json({ message: e.message });
  }
};

export const createAddress = async (req, res) => {
  try {
    res.status(201).json(await svc.createAddress({ ...req.body, customerId: req.customer.id }));
  } catch (e) {
    console.error('[addressController.createAddress] ERROR:', e.message);
    res.status(e.status || 500).json({ message: e.message });
  }
};

export const updateAddress = async (req, res) => {
  try {
    res.json(await svc.updateAddress({ ...req.body, customerId: req.customer.id, addressId: req.params.id }));
  } catch (e) {
    console.error('[addressController.updateAddress] ERROR:', e.message);
    res.status(e.status || 500).json({ message: e.message });
  }
};

export const deleteAddress = async (req, res) => {
  try {
    res.json(await svc.deleteAddress({ customerId: req.customer.id, addressId: req.params.id }));
  } catch (e) {
    console.error('[addressController.deleteAddress] ERROR:', e.message);
    res.status(e.status || 500).json({ message: e.message });
  }
};

export const setDefaultAddress = async (req, res) => {
  try {
    res.json(await svc.setDefaultAddress({ customerId: req.customer.id, addressId: req.params.id }));
  } catch (e) {
    console.error('[addressController.setDefaultAddress] ERROR:', e.message);
    res.status(e.status || 500).json({ message: e.message });
  }
};