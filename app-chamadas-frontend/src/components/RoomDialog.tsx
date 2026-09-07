import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { Icon } from './Icon';

interface Props { mode: 'create' | 'join'; onClose: () => void; onSubmit: (value: string) => Promise<unknown> }
export function RoomDialog({ mode, onClose, onSubmit }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { dialog.current?.showModal(); }, []);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!value.trim() || busy) return;
    setBusy(true); setError('');
    try { await onSubmit(value); onClose(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Não foi possível concluir a operação.'); setBusy(false); }
  };
  return <dialog ref={dialog} className="room-dialog" onCancel={onClose} onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <form onSubmit={submit}>
      <div className="dialog-heading"><div><h2>{mode === 'create' ? 'Criar uma sala' : 'Entrar em uma sala'}</h2>
        <p>{mode === 'create' ? 'Dê um nome ao novo espaço de trabalho.' : 'Use o código compartilhado por um membro.'}</p></div>
        <button type="button" className="icon-button" aria-label="Fechar" onClick={onClose}><Icon name="close" /></button></div>
      <label htmlFor="roomValue">{mode === 'create' ? 'Nome da sala' : 'Código de convite'}</label>
      <input id="roomValue" autoFocus maxLength={mode === 'create' ? 60 : 16} placeholder={mode === 'create' ? 'Ex.: Projeto Alpha' : 'A7K9-M2QF'}
        value={value} onChange={event => setValue(event.target.value)} required />
      {error && <p className="inline-error" role="alert">{error}</p>}
      <div className="dialog-actions"><button type="button" className="secondary-button" onClick={onClose}>Cancelar</button>
        <button type="submit" className="primary-button" disabled={busy || !value.trim()}>{busy ? 'Aguarde…' : mode === 'create' ? 'Criar sala' : 'Entrar'}</button></div>
    </form>
  </dialog>;
}
