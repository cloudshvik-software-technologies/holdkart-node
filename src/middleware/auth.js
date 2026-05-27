import { verifyToken } from '../config/jwt.js';

  export const authenticate = (req, res, next) => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      return res.status(401).json({ message: 'No token provided' });
    }
    try {
      const decoded = verifyToken(header.split(' ')[1]);
      req.customer = decoded;
      next();
    } catch {
      return res.status(401).json({ message: 'Invalid or expired token' });
    }
  };
  