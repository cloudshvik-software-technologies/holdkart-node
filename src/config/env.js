import 'dotenv/config';
  export default {
    port:            process.env.PORT,
    jwtSecret:       process.env.JWT_SECRET,
    jwtRefreshSecret:process.env.JWT_REFRESH_SECRET,
    frontendUrl:     process.env.FRONTEND_URL,
    razorpayKeyId:   process.env.RAZORPAY_KEY_ID,
    razorpaySecret:  process.env.RAZORPAY_KEY_SECRET,
  };
  
