import { useEffect, useState } from 'react';
import { NexaLogo } from './NexaLogo';
import './LandingPage.css';

const english: Record<string, string> = {
  "Nexa, início": "Nexa, home",
  "Fechar menu": "Close menu",
  "Menu": "Menu",
  "Navegação principal": "Main navigation",
  "Funcionalidades": "Features",
  "Recursos": "Resources",
  "Entrar": "Log in",
  "Começar agora": "Get started",
  "O lugar da sua equipe.": "A place for your team.",
  "Mesmo à distância.": "Even from afar.",
  "Da primeira mensagem à próxima decisão. Reúna conversas, chamadas e o trabalho que vem depois, no Nexa.": "From the first message to the next decision. Bring conversations, calls and the work that follows together in Nexa.",
  "Entrar na minha conta": "Log in to my account",
  "No navegador ou instalado como aplicativo web.": "In your browser or installed as a web app.",
  "Um espaço para conversar e construir": "A space to connect and create",
  "Chat real do Nexa, com salas da equipe e uma conversa de planejamento": "Nexa’s actual chat interface, with team rooms and a planning conversation",
  "A conversa continua.": "The conversation continues.",
  "O contexto também.": "So does the context.",
  "Uma sala para cada assunto. Responda a uma mensagem, mencione quem precisa participar e compartilhe arquivos sem perder o fio da conversa.": "A room for every topic. Reply to messages, mention the right people and share files without losing the thread.",
  "Salas com convite por código": "Rooms with invite codes",
  "Respostas, menções e histórico": "Replies, mentions and message history",
  "Notificações e perfil dos participantes": "Notifications and participant profiles",
  "Precisa conversar ao vivo?": "Need to talk live?",
  "Entre em uma chamada em grupo. Ligue o microfone ou a câmera quando quiser, compartilhe a tela e levante a mão para participar.": "Join a group call. Turn on your microphone or camera when you’re ready, share your screen and raise your hand to join the conversation.",
  "Uma conexão mais leve": "A lighter connection",
  "Modo Eco e qualidade de vídeo adaptativa para acompanhar as condições da sua conexão.": "Eco mode and adaptive video quality that adjust to your connection.",
  "Do seu jeito": "Make it yours",
  "Ajuste o tema, as notificações e os dispositivos. Câmera e microfone começam desligados.": "Choose your theme, notifications and devices. Your camera and microphone start off.",
  "Do encontro ao próximo passo": "From the meeting to the next step",
  "Ferramentas reais da sala do Nexa para organizar agenda, decisões e ações": "Nexa’s actual room tools for organizing agendas, decisions and action items",
  "Boas conversas": "Good conversations",
  "viram próximos passos.": "lead to next steps.",
  "Prepare a pauta, registre decisões e distribua ações. O que foi combinado continua na sala, mesmo depois que a chamada termina.": "Prepare the agenda, record decisions and assign actions. What you agree on stays in the room, even after the call ends.",
  "Criar meu espaço": "Create my workspace",
  "Sua próxima conversa": "Your next conversation",
  "começa aqui.": "starts here.",
  "Conversas, encontros e trabalho em equipe.": "Conversations, meetings and teamwork."
};

export default function LandingPage() {
  const [language, setLanguage] = useState<'pt' | 'en'>(() => { try { return localStorage.getItem('nexa-landing-language') === 'en' ? 'en' : 'pt'; } catch { return 'pt'; } });
  const t = (text: string) => language === 'en' ? english[text] ?? text : text;
  useEffect(() => {
    const previous = document.documentElement.lang;
    document.documentElement.lang = language === 'en' ? 'en' : 'pt-BR';
    try { localStorage.setItem('nexa-landing-language', language); } catch { /* Storage is optional in private browsing. */ }
    return () => { document.documentElement.lang = previous; };
  }, [language]);
  const [menu, setMenu] = useState(false);
  return <main className="landing">
    <header className="landing-nav"><a href="/" aria-label={t("Nexa, início")}><NexaLogo mark /><span>Nexa</span></a>
      <button className="landing-language" type="button" lang={language === 'pt' ? 'en' : 'pt-BR'} aria-label={language === 'pt' ? 'Switch to English' : 'Mudar para português'} onClick={() => setLanguage(language === 'pt' ? 'en' : 'pt')}>{language === 'pt' ? 'English' : 'Português'}</button>
      <button className="landing-menu" aria-expanded={menu} aria-controls="landing-links" onClick={() => setMenu(!menu)}>{t(menu ? 'Fechar menu' : 'Menu')}</button>
      <nav id="landing-links" className={menu ? 'is-open' : ''} aria-label={t("Navegação principal")} onClick={() => setMenu(false)}><a href="#funcionalidades">{t("Funcionalidades")}</a><a href="#recursos">{t("Recursos")}</a><a href="/login">{t("Entrar")}</a><a className="landing-button" href="/register">{t("Começar agora")}</a></nav>
    </header>
    <section className="landing-hero"><div className="landing-intro"><h1>{t("O lugar da sua equipe.")}<br />{t("Mesmo à distância.")}</h1><p>{t("Da primeira mensagem à próxima decisão. Reúna conversas, chamadas e o trabalho que vem depois, no Nexa.")}</p><div className="landing-actions"><a className="landing-button" href="/register">{t("Começar agora")}</a><a className="landing-text-link" href="/login">{t("Entrar na minha conta")}</a></div><p className="landing-note">{t("No navegador ou instalado como aplicativo web.")}</p></div>
      <figure className="landing-window landing-hero-window"><figcaption><span className="window-dots" aria-hidden="true">● ● ●</span><span>{t("Um espaço para conversar e construir")}</span></figcaption><img src="/screenshots/chat.png" width="1440" height="960" fetchPriority="high" alt={t("Chat real do Nexa, com salas da equipe e uma conversa de planejamento")} /></figure>
    </section>
    <section id="funcionalidades" className="landing-section landing-conversation"><div><h2>{t("A conversa continua.")}<br />{t("O contexto também.")}</h2><p>{t("Uma sala para cada assunto. Responda a uma mensagem, mencione quem precisa participar e compartilhe arquivos sem perder o fio da conversa.")}</p><ul><li>{t("Salas com convite por código")}</li><li>{t("Respostas, menções e histórico")}</li><li>{t("Notificações e perfil dos participantes")}</li></ul></div><div className="landing-feature-list"><article><h3>{t("Precisa conversar ao vivo?")}</h3><p>{t("Entre em uma chamada em grupo. Ligue o microfone ou a câmera quando quiser, compartilhe a tela e levante a mão para participar.")}</p></article><article><h3>{t("Uma conexão mais leve")}</h3><p>{t("Modo Eco e qualidade de vídeo adaptativa para acompanhar as condições da sua conexão.")}</p></article><article><h3>{t("Do seu jeito")}</h3><p>{t("Ajuste o tema, as notificações e os dispositivos. Câmera e microfone começam desligados.")}</p></article></div></section>
    <section id="recursos" className="landing-section landing-organize"><figure className="landing-window"><figcaption><span className="window-dots" aria-hidden="true">● ● ●</span><span>{t("Do encontro ao próximo passo")}</span></figcaption><img src="/screenshots/meeting.png" width="1440" height="960" loading="lazy" decoding="async" alt={t("Ferramentas reais da sala do Nexa para organizar agenda, decisões e ações")} /></figure><div><h2>{t("Boas conversas")}<br />{t("viram próximos passos.")}</h2><p>{t("Prepare a pauta, registre decisões e distribua ações. O que foi combinado continua na sala, mesmo depois que a chamada termina.")}</p><a className="landing-text-link" href="/register">{t("Criar meu espaço")}</a></div></section>
    <section className="landing-close"><h2>{t("Sua próxima conversa")}<br />{t("começa aqui.")}</h2><a className="landing-button" href="/register">{t("Começar agora")}</a></section>
    <footer className="landing-footer"><a href="/" aria-label={t("Nexa, início")}><NexaLogo mark /><span>Nexa</span></a><p>{t("Conversas, encontros e trabalho em equipe.")}</p><a href="/login">{t("Entrar")}</a></footer>
  </main>;
}
