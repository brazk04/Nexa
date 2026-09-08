import { useEffect, useState } from 'react';
import type { CSSProperties, FormEvent } from 'react';
import { ApiError } from '../lib/api';
import type { RegisterInput } from '../hooks/useAuth';
import { NexaLogo } from './NexaLogo';

interface Props {
  initialMode?: 'login' | 'register';
  login: (username: string, password: string) => Promise<void>;
  register: (input: RegisterInput) => Promise<{ emailSent: boolean; message: string }>;
  verify: (token: string) => Promise<void>;
  resend: (username: string, password: string) => Promise<{ message: string }>;
}
type Mode = 'login' | 'register' | 'verify';

export function AuthScreen({ login, register, verify, resend, initialMode = 'login' }: Props) {
  const initialToken = new URLSearchParams(window.location.search).get('verify') ?? '';
  const [mode, setMode] = useState<Mode>(initialToken ? 'verify' : initialMode);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [email, setEmail] = useState('');
  const [birthDate, setBirthDate] = useState('');
  const [busy, setBusy] = useState(Boolean(initialToken));
  const [error, setError] = useState('');
  const [message, setMessage] = useState(initialToken ? 'Validando seu e-mail…' : '');
  const [backgroundPaused, setBackgroundPaused] = useState(document.visibilityState !== 'visible');

  useEffect(() => {
    const update = () => setBackgroundPaused(document.visibilityState !== 'visible');
    document.addEventListener('visibilitychange', update);
    return () => document.removeEventListener('visibilitychange', update);
  }, []);

  useEffect(() => {
    if (!initialToken) return;
    let active = true;
    void verify(initialToken).catch(failure => {
      if (active) { setError(failure instanceof Error ? failure.message : 'Não foi possível verificar o e-mail.'); setMessage(''); setBusy(false); }
    });
    return () => { active = false; };
  }, [initialToken, verify]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError(''); setMessage('');
    try {
      if (mode === 'login') await login(username, password);
      else {
        if (password.length < 8 || !/[\p{L}]/u.test(password) || !/\p{N}/u.test(password)) throw new Error('A senha precisa ter ao menos 8 caracteres, uma letra e um número.');
        const result = await register({ username, password, email, birthDate });
        setMode('verify'); setMessage(result.message);
      }
    } catch (failure) {
      if (failure instanceof ApiError && failure.code === 'EMAIL_UNVERIFIED') setMode('verify');
      setError(failure instanceof Error ? failure.message : 'Não foi possível concluir a operação.');
    } finally { setBusy(false); }
  };
  const resendEmail = async () => {
    if (!username || !password || busy) { setError('Informe seu nome de usuário e senha para reenviar.'); return; }
    setBusy(true); setError(''); setMessage('');
    try { setMessage((await resend(username, password)).message); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Não foi possível reenviar.'); }
    finally { setBusy(false); }
  };
  const changeMode = (next: Mode) => { setMode(next); setError(''); setMessage(''); };

  return <main className={`entry-page ${backgroundPaused ? 'is-background-paused' : ''}`}>
    <div className="entry-atmosphere" aria-hidden="true">
      <span className="mesh mesh-one" /><span className="mesh mesh-two" />
      {Array.from({ length: 10 }, (_, index) => <i key={index} style={{ '--particle': index } as CSSProperties} />)}
    </div>
    <section className="entry-content">
      <div className="entry-copy"><NexaLogo className="entry-hero-logo" />
        <span className="entry-eyebrow">Colaboração que mantém o foco</span>
        <h1>O trabalho acontece <br />entre pessoas.</h1>
        <p>Converse com sua equipe em salas privadas, compartilhe ideias e transforme uma conversa em chamada.</p>
        <div className="entry-capabilities" aria-label="Recursos principais"><span>Salas privadas</span><span>Chat em tempo real</span><span>Chamadas em grupo</span></div>
      </div>
      {mode !== 'verify' ? <form className="entry-form" onSubmit={submit}>
        <h2>{mode === 'login' ? 'Entre na sua conta.' : 'Crie seu espaço.'}</h2>
        <p>{mode === 'login' ? 'Suas salas continuam onde você deixou.' : 'Comece sem salas e construa seu próprio workspace.'}</p>
        <label htmlFor="username">Nome de usuário</label>
        <input id="username" autoFocus autoComplete="username" placeholder="Ex.: braz.silva" minLength={3} maxLength={32}
          pattern="[A-Za-zÀ-ž0-9_.-]+" value={username} onChange={event => setUsername(event.target.value)} required />
        {mode === 'register' && <>
          <label htmlFor="birthDate">Data de nascimento</label>
          <input id="birthDate" type="date" autoComplete="bday" max={new Date().toISOString().slice(0, 10)} value={birthDate} onChange={event => setBirthDate(event.target.value)} required />
          <label htmlFor="email">E-mail</label>
          <input id="email" type="email" autoComplete="email" maxLength={254} placeholder="voce@empresa.com" value={email} onChange={event => setEmail(event.target.value)} required />
        </>}
        <label htmlFor="password">Senha</label>
        <input id="password" type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} minLength={8} maxLength={128}
          value={password} onChange={event => setPassword(event.target.value)} required />
        {error && <p role="alert" className="inline-error">{error}</p>}
        <button className="primary-button" type="submit" disabled={busy}>{busy ? 'Aguarde…' : mode === 'login' ? 'Entrar' : 'Criar conta'}</button>
        <button className="text-button" type="button" onClick={() => changeMode(mode === 'login' ? 'register' : 'login')}>
          {mode === 'login' ? 'Ainda não tenho uma conta' : 'Já tenho uma conta'}
        </button>
        <small>{mode === 'login' ? 'O acesso utiliza seu nome de usuário e senha.' : 'Você precisará verificar o e-mail antes do primeiro acesso.'}</small>
      </form> : <section className="entry-form verification-card">
        <span className="verification-icon" aria-hidden="true">✓</span>
        <h2>Verifique seu e-mail.</h2>
        <p>{message || 'Abra o link enviado para concluir seu cadastro.'}</p>
        {error && <p role="alert" className="inline-error">{error}</p>}
        <div className="verification-fields">
          <label htmlFor="resendUsername">Nome de usuário</label>
          <input id="resendUsername" autoComplete="username" value={username} onChange={event => setUsername(event.target.value)} />
          <label htmlFor="resendPassword">Senha</label>
          <input id="resendPassword" type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} />
        </div>
        <button className="primary-button" type="button" disabled={busy} onClick={() => void resendEmail()}>{busy ? 'Aguarde…' : 'Reenviar verificação'}</button>
        <button className="text-button" type="button" onClick={() => changeMode('login')}>Voltar para o login</button>
      </section>}
    </section>
    <footer>Um lugar para construir em conjunto.</footer>
  </main>;
}
