import { test } from 'node:test';
import assert from 'node:assert/strict';
import nodemailer from 'nodemailer';
import { verificationEmail } from '../src/email-template';

test('confirmação usa Nexa, escapa HTML e mantém o token no link correto', () => {
  const token = 'token&with=reserved?characters';
  const mail = verificationEmail('<img src=x onerror=alert(1)>', token, 'https://heynexa.vercel.app/');
  assert.equal(mail.subject, 'Confirme seu e-mail no Nexa');
  assert.ok(!mail.html.includes('<img'));
  assert.ok(mail.html.includes('&lt;img'));
  assert.ok(!mail.html.includes('Coworking Platform'));
  const link = mail.text.split('\n').find(line => line.startsWith('https://'))!;
  assert.equal(new URL(link).searchParams.get('verify'), token);
  assert.equal(new URL(link).origin, 'https://heynexa.vercel.app');
  assert.ok(mail.html.includes('1 hora'));
  assert.throws(() => verificationEmail('Test', token, 'javascript:alert(1)'));
});

test('confirmação gera alternativas texto e HTML sem envio externo', async () => {
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true });
  const result = await transport.sendMail({
    from: { name: 'Nexa', address: 'test@example.com' }, to: 'recipient@example.com',
    ...verificationEmail('Ana', 'test-only', 'https://heynexa.vercel.app'),
  });
  const mime = result.message.toString();
  assert.match(mime, /multipart\/alternative/);
  assert.match(mime, /text\/plain/);
  assert.match(mime, /text\/html/);
  assert.match(mime, /From: Nexa <test@example.com>/);
});
