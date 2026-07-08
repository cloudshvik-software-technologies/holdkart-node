import 'dotenv/config';
  export default {
    port:            process.env.PORT,
    jwtSecret:       process.env.JWT_SECRET,
    jwtRefreshSecret:process.env.JWT_REFRESH_SECRET,
    frontendUrl:     process.env.FRONTEND_URL,
    razorpayKeyId:   process.env.RAZORPAY_KEY_ID,
    razorpaySecret:  process.env.RAZORPAY_KEY_SECRET,
    s3: {
      region:          process.env.AWS_REGION || 'ap-south-1',
      accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      bucket:          process.env.S3_BUCKET_NAME || 'holdkart-media-prod',
      publicBaseUrl:   process.env.S3_PUBLIC_BASE_URL || '',
    },
  };
  
