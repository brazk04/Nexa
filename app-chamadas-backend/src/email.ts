import nodemailer from 'nodemailer';
import { verificationEmail } from './email-template';

export interface VerificationMessage { email: string; username: string; token: string }
export type VerificationSender = (message: VerificationMessage) => Promise<boolean>;

export function createVerificationSender(): VerificationSender {
  const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, EMAIL_FROM } = process.env;
  if (!SMTP_HOST || !SMTP_PORT || !SMTP_USER || !SMTP_PASS || !EMAIL_FROM) {
    return async () => false;
  }
  const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: Number(SMTP_PORT),
    secure: process.env.SMTP_SECURE === 'true',
    requireTLS: process.env.SMTP_SECURE !== 'true',
    connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000,
    disableFileAccess: true, disableUrlAccess: true,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  const frontendUrl = (process.env.FRONTEND_URL ?? 'http://localhost:5173').replace(/\/$/, '');
  return async ({ email, username, token }) => {
    const result = await transporter.sendMail({
      from: { name: 'Nexa', address: EMAIL_FROM.match(/<([^<>]+)>/)?.[1] ?? EMAIL_FROM.trim() },
      to: email,
      ...verificationEmail(username, token, frontendUrl),
    });
    return result.accepted.length > 0;
  };
}
