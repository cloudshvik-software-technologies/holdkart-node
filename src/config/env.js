import 'dotenv/config';
  export default {
    port:            process.env.PORT             || 8081,
    jwtSecret:       process.env.JWT_SECRET       || 'customer_access_secret',
    jwtRefreshSecret:process.env.JWT_REFRESH_SECRET || 'customer_refresh_secret',
    frontendUrl:     process.env.FRONTEND_URL     || 'http://localhost:5174/',
    razorpayKeyId:   process.env.RAZORPAY_KEY_ID,
    razorpaySecret:  process.env.RAZORPAY_KEY_SECRET,
  };
  