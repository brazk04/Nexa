interface Props {
  className?: string;
  compact?: boolean;
  mark?: boolean;
}

export function NexaLogo({ className = '', compact = false, mark = false }: Props) {
  if (mark) return <span className={`nexa-mark ${compact ? 'nexa-mark-compact' : ''} ${className}`} role="img" aria-label="Nexa" />;
  return <img className={`nexa-logo ${compact ? 'nexa-logo-compact' : ''} ${className}`} src="/nexa-logo.png" alt="Nexa" />;
}
