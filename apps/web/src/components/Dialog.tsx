import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const openDialogs: HTMLElement[] = [];
const focusable = 'button:not(:disabled), input:not(:disabled):not([type="hidden"]), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])';

export function Dialog({ title, description, children, onClose, wide, returnFocus }: { title: string; description?: string; children: ReactNode; onClose: () => void; wide?: boolean; returnFocus?: HTMLElement | null }) {
  const titleId = useId();
  const descriptionId = useId();
  const card = useRef<HTMLDivElement>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  // Capture before the portal commits: a child autoFocus runs before this effect.
  const previousFocus = useRef(returnFocus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null));
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const element = card.current!;
    const previousOverflow = document.body.style.overflow;
    const siblings = Array.from(document.body.children).filter((child): child is HTMLElement => child instanceof HTMLElement && child !== backdrop.current);
    const inertStates = siblings.map((child) => child.inert);
    siblings.forEach((child) => { child.inert = true; });
    document.body.style.overflow = 'hidden';
    openDialogs.push(element);
    const getFocusable = () => Array.from(element.querySelectorAll<HTMLElement>(focusable)).filter((item) => item.getClientRects().length > 0);
    const initial = element.querySelector<HTMLElement>('input:not(:disabled), textarea:not(:disabled), select:not(:disabled)') ?? getFocusable()[0] ?? element;
    initial.focus();
    const keydown = (event: KeyboardEvent) => {
      if (openDialogs.at(-1) !== element) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        close.current();
      } else if (event.key === 'Tab') {
        const items = getFocusable();
        const first = items[0] ?? element;
        const last = items.at(-1) ?? element;
        if (!items.length || (event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last) || !element.contains(document.activeElement)) {
          event.preventDefault();
          (event.shiftKey ? last : first).focus();
        }
      }
    };
    const focusin = (event: FocusEvent) => {
      if (openDialogs.at(-1) === element && !element.contains(event.target as Node)) (getFocusable()[0] ?? element).focus();
    };
    document.addEventListener('keydown', keydown, true);
    document.addEventListener('focusin', focusin);
    return () => {
      document.removeEventListener('keydown', keydown, true);
      document.removeEventListener('focusin', focusin);
      openDialogs.splice(openDialogs.indexOf(element), 1);
      siblings.forEach((child, index) => { child.inert = inertStates[index]; });
      document.body.style.overflow = previousOverflow;
      if (previousFocus.current?.isConnected) previousFocus.current.focus();
    };
  }, []);
  return createPortal(
    <div ref={backdrop} className="modal-backdrop app-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={card} className={`modal app-dialog ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={description ? descriptionId : undefined} tabIndex={-1}>
        <div className="modal-head">
          <h2 id={titleId}>{title}</h2>
          <button type="button" className="btn ghost" onClick={onClose} aria-label="닫기">✕</button>
        </div>
        <div className="modal-body">
          {description && <p id={descriptionId} className="muted">{description}</p>}
          {children}
        </div>
      </div>
    </div>, document.body,
  );
}

type DialogOptions = { title: string; description?: string; confirmText?: string };
type InputOptions = DialogOptions & { label: string; maxLength?: number; initialValue?: string };
type ConfirmOptions = DialogOptions & { destructive?: boolean };

export function InputDialog({ onClose, onConfirm, label, maxLength, initialValue = '', confirmText = '확인', ...options }: InputOptions & { onClose: () => void; onConfirm: (value: string) => void }) {
  const [value, setValue] = useState(initialValue);
  const inputId = useId();
  return <Dialog {...options} onClose={onClose}>
    <form className="dialog-form" onSubmit={(event) => { event.preventDefault(); if (value.trim()) onConfirm(value.trim()); }}>
      <label htmlFor={inputId}>{label}</label>
      <input id={inputId} className="input" autoFocus required maxLength={maxLength} value={value} onChange={(event) => setValue(event.target.value)} />
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onClose}>취소</button>
        <button type="submit" className="btn primary" disabled={!value.trim()}>{confirmText}</button>
      </div>
    </form>
  </Dialog>;
}

export function ConfirmDialog({ onClose, onConfirm, confirmText = '확인', destructive, ...options }: ConfirmOptions & { onClose: () => void; onConfirm: () => void }) {
  return <Dialog {...options} onClose={onClose}>
    <form onSubmit={(event) => { event.preventDefault(); onConfirm(); }}>
      <div className="modal-actions">
        <button type="button" className="btn" onClick={onClose}>취소</button>
        <button type="submit" className={`btn ${destructive ? 'danger' : 'primary'}`}>{confirmText}</button>
      </div>
    </form>
  </Dialog>;
}

type Request = { kind: 'input'; options: InputOptions; resolve: (value: string | null) => void }
  | { kind: 'confirm'; options: ConfirmOptions; resolve: (value: boolean) => void }
  | { kind: 'notice'; options: DialogOptions; resolve: () => void };
type DialogService = { input: (options: InputOptions) => Promise<string | null>; confirm: (options: ConfirmOptions) => Promise<boolean>; notice: (options: DialogOptions) => Promise<void> };
const DialogContext = createContext<DialogService | null>(null);

export function DialogProvider({ children }: { children: ReactNode }) {
  const [requests, setRequests] = useState<(Request & { id: number })[]>([]);
  const pending = useRef<(Request & { id: number })[]>([]);
  const nextId = useRef(0);
  const [service] = useState<DialogService>(() => {
    const enqueue = (request: Request) => { pending.current.push({ ...request, id: nextId.current++ }); setRequests([...pending.current]); };
    return {
      input: (options) => new Promise((resolve) => enqueue({ kind: 'input', options, resolve })),
      confirm: (options) => new Promise((resolve) => enqueue({ kind: 'confirm', options, resolve })),
      notice: (options) => new Promise((resolve) => enqueue({ kind: 'notice', options, resolve })),
    };
  });
  useEffect(() => () => {
    pending.current.forEach((request) => {
      if (request.kind === 'input') request.resolve(null);
      else if (request.kind === 'confirm') request.resolve(false);
      else request.resolve();
    });
    pending.current = [];
  }, []);
  const request = requests[0];
  const finish = () => { pending.current.shift(); setRequests([...pending.current]); };
  const cancel = () => {
    if (!request) return;
    if (request.kind === 'input') request.resolve(null);
    else if (request.kind === 'confirm') request.resolve(false);
    else request.resolve();
    finish();
  };
  return <DialogContext.Provider value={service}>
    {children}
    {request?.kind === 'input' && <InputDialog key={request.id} {...request.options} onClose={cancel} onConfirm={(value) => { request.resolve(value); finish(); }} />}
    {request?.kind === 'confirm' && <ConfirmDialog key={request.id} {...request.options} onClose={cancel} onConfirm={() => { request.resolve(true); finish(); }} />}
    {request?.kind === 'notice' && <Dialog key={request.id} {...request.options} onClose={cancel}><div className="modal-actions"><button className="btn primary" onClick={cancel}>{request.options.confirmText ?? '확인'}</button></div></Dialog>}
  </DialogContext.Provider>;
}

export function useDialogs() {
  const service = useContext(DialogContext);
  if (!service) throw new Error('DialogProvider is required');
  return service;
}
