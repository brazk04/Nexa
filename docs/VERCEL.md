# Nexa na Vercel

Esta pasta agora está organizada para dois projetos Vercel no mesmo repositório:

- `app-chamadas-frontend`: site React/Vite;
- `app-chamadas-backend`: API Express, Socket.IO e Prisma.

O banco de produção deve ser PostgreSQL provisionado pela integração do Marketplace da Vercel (Neon, Supabase ou outro provedor). O Nexa não importa o `prisma/dev.db`; a base nova começa vazia.

## Projeto do frontend

Na criação do projeto Vercel, selecione `app-chamadas-frontend` como **Root Directory**. O `vercel.json` já define o build Vite, a pasta `dist` e o fallback de SPA.

Variáveis de produção:

```text
VITE_API_URL=https://SEU-BACKEND.vercel.app
VITE_SOCKET_URL=https://SEU-BACKEND.vercel.app
VITE_SOCKET_TRANSPORTS=websocket
```

## Projeto do backend

Crie um segundo projeto apontando para `app-chamadas-backend` como **Root Directory**. O entrypoint `api/index.ts` exporta o servidor Express/Socket.IO e o `vercel.json` encaminha as rotas REST e WebSocket.

Variáveis mínimas:

```text
DATABASE_URL=postgresql://...
NODE_ENV=production
CORS_ORIGIN=https://SEU-FRONTEND.vercel.app
FRONTEND_URL=https://SEU-FRONTEND.vercel.app
COOKIE_SAME_SITE=none
SMTP_HOST=...
SMTP_PORT=587
SMTP_SECURE=true
SMTP_USER=...
SMTP_PASS=...
EMAIL_FROM=Nexa <noreply@seu-dominio.com>
```

## Inicialização da base nova

Depois de criar o PostgreSQL, defina `DATABASE_URL` localmente (sem commitar o valor) e execute uma única vez:

```powershell
cd app-chamadas-backend
npm ci
$env:DATABASE_URL="postgresql://..."
npm run db:push:postgres
```

Esse comando cria as tabelas do Nexa no PostgreSQL sem copiar o banco SQLite de testes. O script usa o schema atual apenas como fonte dos modelos e troca o datasource para PostgreSQL durante a execução.

## Pendências antes de produção

O entrypoint Vercel usa `/tmp/nexa-storage` apenas para evitar falha de inicialização. Avatares e anexos precisam ser ligados a armazenamento persistente (Vercel Blob, S3 ou similar) antes do uso real.

O Socket.IO da Vercel funciona com transporte WebSocket direto, mas presença, salas de chamada e coordenação entre instâncias não podem depender dos `Map` em memória atuais. Para escala, usar Redis/adapter externo e mover esse estado para ele. Consulte [WebSockets nas Vercel Functions](https://vercel.com/docs/functions/websockets).

Após configurar as URLs e os serviços, publique primeiro o backend, depois o frontend, valide cadastro/login/chat/chamadas e só então considere a base pronta para uso.
