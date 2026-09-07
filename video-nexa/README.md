# Imagens para o vídeo do Nexa

Capturas reais do sistema, organizadas em uma sequência sugerida para apresentação:

1. `01-chat-da-sala.png` — salas, presença e chat com mensagens.
2. `02-central-da-reuniao.png` — agenda, decisões e ações da reunião.
3. `03-landing-desktop.png` — landing page em desktop.
4. `04-landing-mobile.png` — landing page em celular.

As capturas foram feitas com uma conta de demonstração isolada e não contêm dados reais de usuários.

## Vídeos

- `nexa-apresentacao-horizontal.webm` — formato 16:9 para apresentação e desktop.
- `nexa-apresentacao-vertical.webm` — formato 9:16 para Shorts, Reels e TikTok.

Para recriar os vídeos depois de substituir as imagens, execute na raiz do projeto:

```bash
node video-nexa/create-videos.mjs
```

## Prints separados

A pasta `telas/16x9` e `telas/9x16` contém uma imagem individual para cada tela, já enquadrada nos formatos horizontal e vertical. Para recriá-las:

```bash
node video-nexa/create-screen-prints.mjs
```

As seções da landing também estão separadas em `telas/16x9/landing-secoes` e `telas/9x16/landing-secoes`: hero, funcionalidades, recursos, CTA final e rodapé. Para recriá-las:

```bash
node video-nexa/create-landing-sections.mjs
```
