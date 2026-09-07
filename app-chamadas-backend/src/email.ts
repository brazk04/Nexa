import nodemailer from 'nodemailer';

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
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  const frontendUrl = (process.env.FRONTEND_URL ?? 'http://localhost:5173').replace(/\/$/, '');
  return async ({ email, username, token }) => {
    const link = `${frontendUrl}/?verify=${encodeURIComponent(token)}`;
    await transporter.sendMail({
      from: EMAIL_FROM,
      to: email,
      subject: 'Verifique seu e-mail — Coworking Platform',
      text: `Olá, ${username}. Confirme seu e-mail acessando este link (válido por 1 hora): ${link}`,
      html: `<p>Olá, <strong>${escapeHtml(username)}</strong>.</p><p>Confirme seu e-mail para acessar a Coworking Platform.</p><p><a href="${link}">Verificar meu e-mail</a></p><p>Este link expira em 1 hora.</p>`,
    });
    return true;
  };
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}
