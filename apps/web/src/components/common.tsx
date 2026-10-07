import { useEffect, useState, type ReactNode } from 'react';
import { Dialog } from './Dialog';
import type { SocketStatus } from '../core/battleSocket';

export function Countdown({ deadlineAt, now, paused, big }: { deadlineAt: number | null; now: number; paused?: boolean; big?: boolean }) {
  if (deadlineAt === null) return null;
  const ms = Math.max(0, deadlineAt - now);
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  const urgent = ms < 10_000;
  return (
    <span className={`countdown ${urgent ? 'urgent' : ''} ${big ? 'big' : ''} ${paused ? 'paused' : ''}`} aria-live="polite">
      {paused ? '⏸ ' : '⏱ '}
      {m}:{String(s).padStart(2, '0')}
    </span>
  );
}

const STATUS_TEXT: Record<SocketStatus, string> = {
  idle: '대기',
  connecting: '연결 중…',
  joining: '참가 중…',
  live: '연결됨',
  reconnecting: '재연결 중…',
  closed: '연결 종료',
  fatal: '연결 불가',
};

export function ConnectionBadge({ status, pending }: { status: SocketStatus; pending?: number }) {
  return (
    <span className={`conn-badge conn-${status}`} title="서버 연결 상태">
      <span className="dot" /> {STATUS_TEXT[status]}
      {pending ? <span className="pending-pill">전송 대기 {pending}</span> : null}
    </span>
  );
}

export function StateBadge({ state }: { state: string }) {
  const label: Record<string, string> = {
    CREATED: '생성됨',
    LOBBY: '대기실',
    READY: '준비 완료',
    ACTIVE: '진행 중',
    PAUSED: '일시정지',
    FINISHED: '종료',
    PENDING: '대기',
    PREPARE: '준비',
    LOCKED: '마감',
    RESULT: '결과 공개',
  };
  return <span className={`state-badge st-${state.toLowerCase()}`}>{label[state] ?? state}</span>;
}

export function Toast({ message, kind = 'info', onDone }: { message: string | null; kind?: 'info' | 'error' | 'success'; onDone?: () => void }) {
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => onDone?.(), 3500);
    return () => clearTimeout(t);
  }, [message, onDone]);
  if (!message) return null;
  return <div className={`toast toast-${kind}`} role="status">{message}</div>;
}

export function useToast() {
  const [toast, setToast] = useState<{ message: string; kind: 'info' | 'error' | 'success' } | null>(null);
  return {
    toast,
    show: (message: string, kind: 'info' | 'error' | 'success' = 'info') => setToast({ message, kind }),
    clear: () => setToast(null),
  };
}

export function Modal({ title, children, onClose, wide }: { title: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  return <Dialog title={title} onClose={onClose} wide={wide}>{children}</Dialog>;
}

export const ERROR_TEXT: Record<string, string> = {
  INVALID_JOIN_CODE: '존재하지 않는 참가 코드입니다.',
  SESSION_FINISHED: '이미 종료된 세션입니다.',
  JOIN_BLOCKED: '시도가 너무 많습니다. 잠시 후 다시 시도하세요.',
  SESSION_FULL: '정원이 가득 찼습니다.',
  SESSION_CLOSED: '지금은 참가할 수 없는 세션입니다.',
  NICKNAME_TAKEN: '이미 사용 중인 닉네임입니다.',
  LOGIN_REQUIRED: '로그인이 필요한 세션입니다.',
  NOT_IN_CLASSROOM: '이 학급 학생만 참가할 수 있습니다.',
  KICKED: '교사에 의해 세션에서 제외되었습니다.',
  INVALID_RESUME_TOKEN: '이전 참가 정보가 유효하지 않습니다. 다시 참가하세요.',
  SUBMISSION_CLOSED: '제출 시간이 종료되었습니다.',
  SESSION_LOCKED: '시험이 종료되어 답안이 잠겼습니다.',
  EDIT_NOT_ALLOWED: '답안을 수정할 수 없습니다.',
  QUESTION_NOT_ACTIVE: '아직 문제가 열리지 않았습니다.',
  INVALID_ANSWER: '답안 형식이 올바르지 않습니다.',
  STALE_REVISION: '다른 곳에서 답안이 변경되었습니다. 새로고침된 답안을 확인하세요.',
  RATE_LIMITED: '요청이 너무 많습니다. 잠시 후 다시 시도하세요.',
  FORBIDDEN: '권한이 없습니다.',
  UNAUTHENTICATED: '로그인이 필요합니다.',
  INVALID_TRANSITION: '현재 상태에서 할 수 없는 작업입니다.',
  AI_UNAVAILABLE: 'AI 기능을 사용할 수 없습니다. 서버의 AI 설정(API 키)을 확인하세요.',
  AI_FAILED: 'AI가 요청을 처리하지 못했습니다. 조건을 바꾸거나 잠시 후 다시 시도해 주세요.',
};

export const errorText = (code: string, fallback?: string) => ERROR_TEXT[code] ?? fallback ?? code;
