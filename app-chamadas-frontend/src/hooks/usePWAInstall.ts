import { useCallback, useEffect, useState } from 'react';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
}

type IOSNavigator = Navigator & { standalone?: boolean };

export interface PWAInstaller {
  available: boolean;
  manual: boolean;
  installed: boolean;
  install: () => Promise<'accepted' | 'dismissed' | 'manual' | 'unavailable'>;
}

export function usePWAInstall(): PWAInstaller {
  const [promptEvent, setPromptEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(() => window.matchMedia('(display-mode: standalone)').matches || Boolean((navigator as IOSNavigator).standalone));
  const manual = !installed && /iphone|ipad|ipod/i.test(navigator.userAgent);

  useEffect(() => {
    const beforeInstall = (event: Event) => {
      event.preventDefault(); setPromptEvent(event as BeforeInstallPromptEvent);
    };
    const appInstalled = () => { setInstalled(true); setPromptEvent(null); };
    window.addEventListener('beforeinstallprompt', beforeInstall);
    window.addEventListener('appinstalled', appInstalled);
    return () => { window.removeEventListener('beforeinstallprompt', beforeInstall); window.removeEventListener('appinstalled', appInstalled); };
  }, []);

  const install = useCallback(async () => {
    if (manual) return 'manual' as const;
    if (!promptEvent) return 'unavailable' as const;
    await promptEvent.prompt();
    const choice = await promptEvent.userChoice;
    setPromptEvent(null);
    return choice.outcome;
  }, [manual, promptEvent]);

  return { available: Boolean(promptEvent) || manual, manual, installed, install };
}
