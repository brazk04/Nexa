# Nexa para Windows

O Nexa pode ser executado como aplicativo Windows por meio do Electron.

## Desenvolvimento

Com o backend disponível em `http://localhost:3333`:

```powershell
npm install
npm run desktop:dev
```

## Gerar instalador

```powershell
npm run desktop:installer
```

O instalador NSIS será criado na pasta `release/`. Para gerar uma versão portátil:

```powershell
npm run desktop:portable
```

O aplicativo desktop é o cliente da plataforma. Ele usa a API e o Socket.IO configurados pelas variáveis `VITE_API_URL` e `VITE_SOCKET_URL`; portanto, o backend precisa estar acessível no endereço configurado antes da distribuição.
