interface Props {
  className?: string;
  compact?: boolean;
}

export function NexaLogo({ className = '', compact = false }: Props) {
  return <img className={`nexa-logo ${compact ? 'nexa-logo-compact' : ''} ${className}`} src="/nexa-logo.png" alt="Nexa" />;
}
