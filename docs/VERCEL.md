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
DIRECT_URL=postgresql://... # endpoint sem pool, apenas para migrations/db push
REDIS_URL=rediss://...      # Upstash Redis/Marketplace
BLOB_READ_WRITE_TOKEN=...   # Vercel Blob privado
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

Use em `DATABASE_URL` o endpoint poolado do Neon (o hostname contém `-pooler`) e em `DIRECT_URL` o endpoint sem pool. O código reutiliza um único `PrismaClient` por processo e o backend foi fixado em `gru1`, a mesma região `sa-east-1` da base atual. Isso reduz conexões abertas, cold starts e latência sem exigir plano pago.

## Tempo real consistente entre instâncias

A Vercel pode manter cada WebSocket em uma Function diferente e recicla a conexão ao atingir a duração máxima. O backend agora usa o Redis Streams Adapter do Socket.IO, recupera a sessão por até dois minutos e deriva presença/chamadas dos sockets distribuídos, em vez de `Map`s isolados.

No Marketplace do projeto `nexa-backend`, adicione **Upstash Redis** no plano gratuito e disponibilize `REDIS_URL` (ou `KV_URL`) em Production e Preview. Sem uma dessas variáveis o desenvolvimento local continua funcional, mas uma produção com mais de uma instância não tem garantia de broadcast entre usuários.

Se a integração adicionar um prefixo próprio ao nome, como `UptashRedisNexa_REDIS_URL`, o backend também o detecta automaticamente.

O `vercel.json` habilita Fluid compute, fixa `gru1` e usa os 300 segundos disponíveis no Hobby. O cliente reconecta com backoff e a recuperação do Socket.IO cobre quedas breves.

## Chamadas em redes restritas

STUN sozinho não conecta todos os pares atrás de NAT/firewall. O endpoint autenticado `/rtc/ice-servers` aceita credenciais server-side do Cloudflare Realtime TURN e entrega apenas credenciais temporárias ao navegador:

```text
CLOUDFLARE_TURN_KEY_ID=...
CLOUDFLARE_TURN_API_TOKEN=...
```

Sem essas variáveis, a aplicação usa os STUNs do Cloudflare e Google. O TURN é o fallback que evita participante visível com vídeo remoto vazio em redes incompatíveis; acompanhe a franquia gratuita no painel do provedor.

## Anexos persistentes

Crie um **Vercel Blob privado** no projeto `nexa-backend`. A integração fornece `BLOB_READ_WRITE_TOKEN`; OIDC também é aceito quando `BLOB_STORE_ID` está disponível. Novos anexos passam a ser gravados no Blob e continuam acessíveis depois que a Function ou o diretório `/tmp` é reciclado. O download continua autenticado pela associação à sala e usa ETag para evitar transferências repetidas.

Arquivos que já haviam desaparecido do `/tmp` não podem ser reconstruídos automaticamente; reenvie somente esses anexos antigos. No Hobby, acompanhe armazenamento, operações e transferência no painel para permanecer na franquia gratuita.

## Inicialização da base nova

Depois de criar o PostgreSQL, defina `DATABASE_URL` localmente (sem commitar o valor) e execute uma única vez:

```powershell
cd app-chamadas-backend
npm ci
$env:DATABASE_URL="postgresql://..."
npm run db:push:postgres
```

Esse comando cria as tabelas do Nexa no PostgreSQL sem copiar o banco SQLite de testes. O script usa o schema atual apenas como fonte dos modelos e troca o datasource para PostgreSQL durante a execução.

Em uma base já existente, aplique somente os índices idempotentes de performance:

```powershell
npm run db:indexes:postgres
```

## Pendências antes de produção

O entrypoint ainda usa `/tmp/nexa-storage` como fallback local. Em produção, `BLOB_READ_WRITE_TOKEN` ou OIDC faz os anexos usarem Vercel Blob privado; avatares já ficam persistidos no banco.

O Socket.IO usa transporte WebSocket direto. Redis é obrigatório na produção para broadcasts, locks de entrada em chamada e recuperação distribuída; mantenha `VITE_SOCKET_TRANSPORTS=websocket` no frontend.

Após configurar as URLs e os serviços, publique primeiro o backend, depois o frontend, valide cadastro/login/chat/chamadas e só então considere a base pronta para uso.
