import jwt from 'jsonwebtoken';
  import 'dotenv/config';

  const ACCESS_SECRET  = process.env.JWT_SECRET         || 'customer_access_secret';
  const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || 'customer_refresh_secret';
  const ACCESS_EXP     = process.env.JWT_EXPIRES_IN     || '1h';
  const REFRESH_EXP    = process.env.JWT_REFRESH_EXPIRES_IN || '7d';

  export const signAccessToken  = (payload) => jwt.sign(payload, ACCESS_SECRET,  { expiresIn: ACCESS_EXP });
  export const signRefreshToken = (payload) => jwt.sign(payload, REFRESH_SECRET, { expiresIn: REFRESH_EXP });
  export const verifyToken      = (token, secret = ACCESS_SECRET) => jwt.verify(token, secret);
  export const verifyRefreshToken = (token) => jwt.verify(token, REFRESH_SECRET);
  