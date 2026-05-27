import nodemailer from 'nodemailer';
  import 'dotenv/config';

  const transporter = nodemailer.createTransport({
    host: process.env.EMAIL_HOST || 'smtp.gmail.com',
    port: Number(process.env.EMAIL_PORT) || 587,
    secure: false,
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  });

  export const sendEmail = async (to, subject, text) => {
    await transporter.sendMail({
      from: `"HoldKart" <${process.env.EMAIL_USER}>`,
      to, subject, text,
    });
  };
  