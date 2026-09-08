// Read-only audit: never print SMTP credentials or send a message.
const { resolveTxt } = require('node:dns/promises');
async function main() {
  const from = process.env.EMAIL_FROM || '';
  const address = from.match(/<([^<>]+)>/)?.[1] || from;
  const domain = address.split('@')[1]?.trim().toLowerCase();
  const authDomain = (process.env.SMTP_USER || '').split('@')[1]?.trim().toLowerCase();
  console.log(JSON.stringify({ smtpHost: process.env.SMTP_HOST, smtpPort: process.env.SMTP_PORT, senderDomain: domain || 'unavailable', authDomain: authDomain || 'unavailable', sameMailbox: address.toLowerCase() === (process.env.SMTP_USER || '').toLowerCase(), frontend: process.env.FRONTEND_URL }));
  if (!domain || !/^[a-z0-9.-]+$/.test(domain)) return;
  for (const [name, prefix] of [[domain, 'v=spf1'], [`_dmarc.${domain}`, 'v=DMARC1']]) {
    try { console.log(name, (await resolveTxt(name)).map(parts => parts.join('')).filter(value => value.startsWith(prefix))); }
    catch (error) { console.log(name, error.code || 'DNS_ERROR'); }
  }
  console.log('DKIM/alignment/inbox placement require the received message headers.');
}
void main();
