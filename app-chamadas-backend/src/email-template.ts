/** Pure renderer: preview/test without issuing a token or sending mail. */
export function verificationEmail(username: string, token: string, frontendUrl: string) {
  const url = new URL('/', frontendUrl);
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Invalid verification URL');
  url.searchParams.set('verify', token);
  const link = url.href;
  const safeLink = escapeHtml(link);
  return {
    subject: 'Confirme seu e-mail no Nexa',
    text: `Olá, ${username}!\n\nConfirme seu endereço de e-mail para continuar no Nexa.\n\n${link}\n\nEste link é válido por 1 hora e só pode ser usado uma vez. Se ele expirar, solicite uma nova confirmação na tela de entrada.\n\nSe você não solicitou esta confirmação, ignore esta mensagem. Não compartilhe este link: ele dá acesso à sua conta.\n\nNexa\nConversas, encontros e trabalho em equipe.`,
    html: `<!doctype html>
<html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Confirme seu e-mail no Nexa</title></head>
<body style="margin:0;padding:0;background-color:#f4f3f8;color:#24212e;font-family:Arial,Helvetica,sans-serif;">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">Confirme seu endereço de e-mail para continuar no Nexa. O link é válido por 1 hora.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#f4f3f8;"><tr><td align="center" style="padding:32px 12px;">
<!--[if mso]><table role="presentation" width="600" align="center"><tr><td><![endif]-->
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background-color:#ffffff;border:1px solid #e6e2ed;border-radius:16px;">
<tr><td style="padding:28px 28px 24px;border-bottom:1px solid #eeeaf5;"><span style="font-size:28px;line-height:36px;font-weight:700;color:#7045cc;letter-spacing:-1px;">Nexa</span></td></tr>
<tr><td style="padding:32px 28px 12px;"><h1 style="margin:0 0 24px;font-size:27px;line-height:35px;letter-spacing:-0.5px;color:#24212e;">Confirme seu e-mail.</h1>
<p style="margin:0 0 16px;font-size:16px;line-height:25px;">Olá, <strong>${escapeHtml(username)}</strong>!</p>
<p style="margin:0 0 26px;font-size:16px;line-height:25px;color:#514b60;">Falta apenas confirmar seu endereço de e-mail para continuar no Nexa.</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td bgcolor="#7045cc" style="border-radius:8px;mso-padding-alt:15px 24px;"><a href="${safeLink}" style="display:inline-block;padding:15px 24px;border:1px solid #7045cc;border-radius:8px;color:#ffffff;font-size:16px;font-weight:700;line-height:22px;text-decoration:none;">Confirmar meu e-mail</a></td></tr></table>
<p style="margin:20px 0 24px;font-size:14px;line-height:22px;color:#645d72;">O link é válido por <strong>1 hora</strong> e só pode ser usado uma vez. Se expirar, solicite uma nova confirmação na tela de entrada.</p>
<p style="margin:0 0 8px;font-size:13px;line-height:21px;color:#645d72;">Se o botão não funcionar, copie e cole este endereço no navegador:</p>
<p style="margin:0 0 24px;font-size:12px;line-height:20px;word-break:break-all;overflow-wrap:anywhere;"><a href="${safeLink}" style="color:#7045cc;text-decoration:underline;word-break:break-all;">${safeLink}</a></p></td></tr>
<tr><td style="padding:22px 28px;background-color:#faf9fc;border-top:1px solid #eeeaf5;border-radius:0 0 16px 16px;">
<p style="margin:0;font-size:13px;line-height:21px;color:#645d72;">Não solicitou esta confirmação? Você pode ignorar esta mensagem. Não compartilhe este link: ele dá acesso à sua conta.</p></td></tr>
</table>
<!--[if mso]></td></tr></table><![endif]-->
<p style="margin:22px 12px 0;font-size:12px;line-height:20px;color:#716a80;">Nexa<br>Conversas, encontros e trabalho em equipe.</p>
</td></tr></table></body></html>`,
  };
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!);
}
