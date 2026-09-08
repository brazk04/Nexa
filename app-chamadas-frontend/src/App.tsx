import { lazy, Suspense } from 'react';
import { useAuth } from './hooks/useAuth';
import { usePWAInstall } from './hooks/usePWAInstall';
import { NexaLogo } from './components/NexaLogo';
import './App.css';

const Workspace = lazy(() => import('./Workspace'));
const AuthScreen = lazy(() => import('./components/AuthScreen').then(module => ({ default: module.AuthScreen })));
const LandingPage = lazy(() => import('./components/LandingPage'));

function LoadingScreen() { return <main className="entry-page loading-page"><div className="entry-brand"><NexaLogo mark /></div><p>Preparando seu espaço…</p></main>; }

export function App() {
  const auth = useAuth(); const installer = usePWAInstall();
  if (auth.loading) return <LoadingScreen />;
  const path = window.location.pathname;
  return <Suspense fallback={<LoadingScreen />}>{auth.user
    ? <Workspace user={auth.user} logout={auth.logout} onUser={auth.updateUser} installer={installer} />
    : path === '/' && !new URLSearchParams(window.location.search).has('verify')
      ? <LandingPage />
      : <AuthScreen initialMode={path === '/register' ? 'register' : 'login'} login={auth.login} register={auth.register} verify={auth.verify} resend={auth.resend} />}</Suspense>;
}
export default App;
