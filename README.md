# Coworking Platform

Plataforma React/TypeScript com contas verificadas, salas privadas persistentes, chat e presença via Socket.io e chamadas WebRTC Mesh de até 15 participantes.

## Executar localmente

Use Node 22.12+ ou 24+. No backend:

```powershell
cd app-chamadas-backend
npm ci
Copy-Item .env.example .env
npm run db:generate
npm run db:migrate
npm run dev
```

Em outro terminal:

```powershell
cd app-chamadas-frontend
npm ci
Copy-Item .env.example .env
npm run dev
```

Abra `http://localhost:5173`. Um novo usuário não recebe salas automáticas: ele cria uma sala ou entra em uma existente com o código de convite.

## E-mail e ambiente

O envio é desacoplado e usa SMTP por meio do Nodemailer. Configure no backend:

- `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS` e `EMAIL_FROM`;
- `FRONTEND_URL`, usado no link de verificação;
- `CORS_ORIGIN`, com as origens permitidas separadas por vírgula;
- `DATABASE_URL`, opcional para sobrescrever o SQLite;
- `NODE_ENV=production`, que habilita `Secure` no cookie;
- `PORT`, padrão `3333`.

Sem credenciais SMTP, o cadastro continua persistido e a interface informa que o envio falhou; o reenvio fica disponível assim que as credenciais forem configuradas. Segredos não devem ser versionados.

No frontend, `VITE_API_URL` e `VITE_SOCKET_URL` apontam para o backend. Ambos usam por padrão o hostname do navegador na porta 3333.

## Segurança e dados

- Login por `username`; username e e-mail possuem índices únicos normalizados no banco.
- Senhas são armazenadas apenas como hash bcrypt (custo 12).
- A verificação usa token aleatório de uso único, armazenado somente como SHA-256 e válido por uma hora.
- A sessão usa token opaco persistido, cookie `HttpOnly`, `SameSite=Lax`, expiração de 30 dias e `Secure` em produção.
- Rotas REST e cada evento Socket.io validam a sessão. O servidor deriva autoria e presença da conta autenticada.
- Toda leitura, mensagem, presença e entrada em chamada exige associação `RoomMember`; conhecer o ID interno não concede acesso.
- Login, cadastro e reenvio possuem rate limit básico em memória.

O Prisma contém `User`, `UserPreference`, `Room`, `RoomMember`, `Mensagem`, `MessageMention`, `Attachment`, `Session`, `EmailVerificationToken`, `CallHistory`, `CallAttendance`, `AgendaItem`, `Decision` e `ActionItem`. As relações opcionais adicionadas a `Mensagem` preservam linhas legadas, enquanto novas mensagens ficam vinculadas ao usuário e à sala.

As migrations `20260906120000_accounts_and_user_rooms` e `20260906183929_collaboration_features` evoluem o banco existente sem recriá-lo. A segunda adiciona preferências, perfil, leitura/favoritos por sala, replies, menções, anexos, histórico de chamadas e dados de reunião.

## Colaboração e configurações

- O perfil oferece nome de exibição, data de nascimento, avatar validado no backend, alteração segura de e-mail e senha, sessões ativas, logout remoto e exclusão confirmada da conta.
- Aparência, densidade, tamanho da fonte, redução de movimento, destaque, notificações, status e dispositivos de mídia são persistidos por usuário. O tema de sistema acompanha mudanças do sistema operacional.
- A seleção de câmera, microfone e saída de áudio usa `enumerateDevices()`, acompanha `devicechange`, oferece preview e medidor local do microfone e aplica `setSinkId()` quando suportado.
- Favoritos, notificações por sala, não lidas e menções são individuais. O modo não perturbe bloqueia notificações de mensagem, menção e chamada sem interromper o chat.
- O chat possui replies, edição e exclusão pelo autor, busca no banco, menções destacadas e anexos corporativos de até 10 MB. Downloads exigem autenticação e associação à sala; excluir uma mensagem também invalida e remove seus anexos.
- Convites funcionam por `/join/CODIGO`, preservam o destino durante autenticação e possuem QR Code gerado pelo backend.
- A central da reunião mantém agenda, itens resolvidos de forma assíncrona, decisões, tarefas simples e histórico de chamadas sem gravação de mídia.

Uploads usam armazenamento local organizado em `storage/avatars` e `storage/files`, ou no caminho definido por `UPLOAD_DIR`. Nomes físicos são aleatórios e a camada fica isolada para futura troca por object storage.

## Chamadas

Cada participante mantém um `RTCPeerConnection` por pessoa remota. Ofertas, respostas e ICE são roteados por socket de destino e cada peer possui sua própria fila de candidates. A entrada do 16º participante é recusada no backend.

Microfone e câmera continuam usando `MediaStreamTrack.enabled`. O compartilhamento substitui o track de vídeo em todos os senders ativos; peers criados durante o compartilhamento já recebem o track da tela. Sair remove apenas o peer correspondente; logout, troca de sala, queda do socket e desmontagem fecham conexões e tracks. O botão Maximizar abre um layout dedicado na viewport sem interromper a chamada.

Durante a chamada há mão levantada ordenada, reações efêmeras identificadas, detecção local de fala, fixação local, painel de participantes, timer, atalhos de teclado, Modo Eco e qualidade adaptativa baseada em estatísticas reais do WebRTC. O Modo Eco reduz bitrate e resolução por `RTCRtpSender.setParameters()` quando o navegador oferece suporte; o fallback não interrompe a chamada.

Eventos Socket.io adicionais: `atualizar_mao`, `enviar_reacao`, `atualizar_midia`, `atualizar_status`, `atualizar_perfil`, `marcar_sala_lida`, `editar_mensagem` e `excluir_mensagem`; o servidor publica `chamada_atualizada`, `reacao_chamada`, `sala_notificada`, `chamada_notificada` e `mensagem_atualizada`, além dos eventos existentes de presença, chat e sinalização.

Os endpoints REST adicionais ficam sob `/preferences`, `/account`, `/rooms/:id`, `/rooms/:id/messages/search`, `/rooms/:id/attachments`, `/rooms/:id/qr`, `/rooms/:id/calls` e `/rooms/:id/meeting`, com subrotas para agenda, decisões e ações. Todas as rotas de dados validam sessão e associação à sala.

Esta V1 usa STUN público e não possui TURN ou SFU. Mesh com 15 pessoas pode exigir upload, CPU e memória elevados, especialmente com vídeo. Para produção em escala, um SFU e infraestrutura TURN serão necessários.

## Verificação

```powershell
# Backend
cd app-chamadas-backend
npm test
npm run typecheck
npm run build

# Frontend
cd ../app-chamadas-frontend
npm run lint
npm run build
npm test
```

Os testes do backend usam banco e armazenamento temporários e cobrem autenticação, hashing, verificação, sessão, autorização, preferências, perfil, favoritos, personalização, menções, replies, edição/exclusão, uploads, sinalização, mão levantada, reações e limite de 15 participantes. Os testes Playwright cobrem cadastro/verificação, criação/entrada por código, chat, persistência, logout, WebRTC Mesh com três participantes, mão levantada, reação, fixação, Modo Eco, entrada durante screen share, maximização, saída isolada e teardown de mídia pendente. A suíte do navegador usa tracks sintéticos, mas `RTCPeerConnection`, SDP, ICE, `getStats`, `setParameters` e `replaceTrack` nativos quando disponíveis no navegador de teste.

Câmeras, microfones, seleção física de saída de áudio, seletor de compartilhamento, SMTP real, redes distintas, TURN e 15 navegadores reais ainda exigem validação manual. Não há gravação de áudio/vídeo, cálculo de energia/CO₂, SFU ou TURN incluído nesta versão.
