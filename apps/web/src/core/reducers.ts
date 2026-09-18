import type {
  LeaderboardChange,
  LeaderboardEntry,
  OwnSubmissionView,
  ScoreboardSessionState,
  ServerEnvelope,
  ServerEventType,
  StudentSessionState,
  TeacherSessionState,
} from '@brainbattle/shared';

type Env = ServerEnvelope<ServerEventType>;

export function applyLeaderboardChanges(entries: LeaderboardEntry[], changes: LeaderboardChange[], removed: string[]): LeaderboardEntry[] {
  const map = new Map(entries.map((e) => [e.participantId, e]));
  for (const id of removed) map.delete(id);
  for (const c of changes) {
    const { prevRank: _prev, ...entry } = c;
    map.set(c.participantId, entry);
  }
  return [...map.values()].sort(
    (a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER) || a.nickname.localeCompare(b.nickname),
  );
}

function upsertSub(list: OwnSubmissionView[], s: OwnSubmissionView): OwnSubmissionView[] {
  const i = list.findIndex((x) => x.sessionQuestionId === s.sessionQuestionId);
  if (i < 0) return [...list, s];
  if (list[i]!.revision > s.revision) return list; // never go backwards (out-of-order replay acks)
  const next = [...list];
  next[i] = { ...list[i], ...s };
  return next;
}

/* ------------------------------------------------------------------ student */

export interface StudentView extends StudentSessionState {
  locked: boolean;
  kicked: boolean;
  lastRejection: { sessionQuestionId: string; code: string; message: string } | null;
}

export function studentReducer(s: StudentView | null, env: Env): StudentView | null {
  if (env.type === 'SESSION_STATE') {
    const p = env.payload as StudentSessionState;
    if (p.role !== 'STUDENT') return s;
    return { ...p, locked: p.state === 'FINISHED', kicked: false, lastRejection: s?.lastRejection ?? null };
  }
  if (!s) return s;
  switch (env.type) {
    case 'SESSION_STATE_CHANGE':
    case 'SESSION_START':
    case 'SESSION_PAUSE':
    case 'SESSION_END': {
      const p = env.payload as { state: StudentView['state']; timing: StudentView['timing'] };
      return { ...s, state: p.state, timing: p.timing, locked: p.state === 'FINISHED' || s.locked };
    }
    case 'SESSION_RESUME': {
      const p = env.payload as ServerEnvelope<'SESSION_RESUME'>['payload'];
      return { ...s, state: p.state, timing: p.timing, questionDeadlineAt: p.questionDeadlineAt };
    }
    case 'SESSION_LOCKED':
      return { ...s, locked: true };
    case 'DEADLINE_UPDATE': {
      const p = env.payload as ServerEnvelope<'DEADLINE_UPDATE'>['payload'];
      return { ...s, timing: { ...s.timing, deadlineAt: p.sessionDeadlineAt }, questionDeadlineAt: p.sessionQuestionId === s.currentSessionQuestionId ? p.questionDeadlineAt : s.questionDeadlineAt };
    }
    case 'QUESTION_PREPARE': {
      const p = env.payload as ServerEnvelope<'QUESTION_PREPARE'>['payload'];
      return { ...s, currentSessionQuestionId: p.sessionQuestionId, currentPhase: 'PREPARE', questionOpensAt: p.opensAt, questionDeadlineAt: null };
    }
    case 'QUESTION_START': {
      const p = env.payload as ServerEnvelope<'QUESTION_START'>['payload'];
      const questions = p.question && !s.questions.some((q) => q.sessionQuestionId === p.sessionQuestionId) ? [...s.questions, p.question] : s.questions;
      return { ...s, questions, currentSessionQuestionId: p.sessionQuestionId, currentPhase: 'ACTIVE', questionDeadlineAt: p.deadlineAt, questionOpensAt: p.startedAt };
    }
    case 'QUESTION_END': {
      const p = env.payload as ServerEnvelope<'QUESTION_END'>['payload'];
      if (p.sessionQuestionId !== s.currentSessionQuestionId) return s;
      return { ...s, currentPhase: s.currentPhase === 'PREPARE' ? 'PENDING' : 'LOCKED' };
    }
    case 'QUESTION_RESULT': {
      const p = env.payload as ServerEnvelope<'QUESTION_RESULT'>['payload'];
      const reveals = p.reveal ? [...s.reveals.filter((r) => r.sessionQuestionId !== p.sessionQuestionId), p.reveal] : s.reveals;
      return { ...s, reveals, currentPhase: p.sessionQuestionId === s.currentSessionQuestionId ? 'RESULT' : s.currentPhase };
    }
    case 'ANSWER_ACCEPTED':
    case 'ANSWER_UPDATED': {
      const p = env.payload as ServerEnvelope<'ANSWER_ACCEPTED'>['payload'];
      return { ...s, submissions: upsertSub(s.submissions, p.submission), lastRejection: null };
    }
    case 'SUBMISSION_GRADED': {
      const p = env.payload as ServerEnvelope<'SUBMISSION_GRADED'>['payload'];
      return { ...s, submissions: upsertSub(s.submissions, p.submission) };
    }
    case 'ANSWER_REJECTED': {
      const p = env.payload as ServerEnvelope<'ANSWER_REJECTED'>['payload'];
      return { ...s, lastRejection: { sessionQuestionId: p.sessionQuestionId, code: p.code, message: p.message } };
    }
    case 'SCORE_UPDATE': {
      const p = env.payload as ServerEnvelope<'SCORE_UPDATE'>['payload'];
      const mine = p.scores.find((x) => x.participantId === s.participantId);
      return mine ? { ...s, score: mine } : s;
    }
    case 'SCOREBOARD_SETTINGS':
      return { ...s, scoreboard: env.payload as StudentView['scoreboard'] };
    case 'RESULTS_RELEASED': {
      const p = env.payload as ServerEnvelope<'RESULTS_RELEASED'>['payload'];
      let subs = s.submissions;
      for (const x of p.submissions) subs = upsertSub(subs, x);
      return { ...s, reveals: p.reveals, submissions: subs, resultsReleased: true };
    }
    case 'KICKED':
      return { ...s, kicked: true };
    default:
      return s;
  }
}

/* ------------------------------------------------------------------ teacher */

/** Structural events after which the teacher client re-requests an authoritative snapshot. */
export const TEACHER_RESYNC_EVENTS = new Set<ServerEventType>([
  'SESSION_STATE_CHANGE',
  'SESSION_START',
  'SESSION_PAUSE',
  'SESSION_RESUME',
  'SESSION_END',
  'QUESTION_PREPARE',
  'QUESTION_START',
  'QUESTION_END',
  'QUESTION_RESULT',
  'DEADLINE_UPDATE',
]);

export function teacherReducer(s: TeacherSessionState | null, env: Env): TeacherSessionState | null {
  if (env.type === 'SESSION_STATE') {
    const p = env.payload as TeacherSessionState;
    return p.role === 'TEACHER' ? p : s;
  }
  if (!s) return s;
  switch (env.type) {
    case 'PARTICIPANT_JOIN': {
      const p = env.payload as ServerEnvelope<'PARTICIPANT_JOIN'>['payload'];
      if (s.participants.some((x) => x.participantId === p.participant.participantId)) return s;
      return { ...s, participants: [...s.participants, p.participant] };
    }
    case 'PARTICIPANT_LEAVE': {
      const p = env.payload as ServerEnvelope<'PARTICIPANT_LEAVE'>['payload'];
      return {
        ...s,
        participants: s.participants.map((x) => (x.participantId === p.participantId ? { ...x, status: p.status } : x)),
        leaderboard: p.status === 'KICKED' ? s.leaderboard.filter((e) => e.participantId !== p.participantId) : s.leaderboard,
      };
    }
    case 'PARTICIPANT_RECONNECT': {
      const p = env.payload as ServerEnvelope<'PARTICIPANT_RECONNECT'>['payload'];
      return { ...s, participants: s.participants.map((x) => (x.participantId === p.participantId ? { ...x, status: 'CONNECTED' } : x)) };
    }
    case 'PARTICIPANT_STATUS': {
      const p = env.payload as ServerEnvelope<'PARTICIPANT_STATUS'>['payload'];
      return {
        ...s,
        participants: s.participants.map((x) =>
          x.participantId === p.participantId
            ? { ...x, status: p.status, ...(p.currentSessionQuestionId !== undefined ? { currentSessionQuestionId: p.currentSessionQuestionId } : {}) }
            : x,
        ),
      };
    }
    case 'SUBMISSION_RECEIVED': {
      const p = env.payload as ServerEnvelope<'SUBMISSION_RECEIVED'>['payload'];
      const subs = s.submissions.filter((x) => x.submissionId !== p.submission.submissionId);
      return {
        ...s,
        submissions: [...subs, p.submission],
        stats: s.stats.map((st) => (st.sessionQuestionId === p.stats.sessionQuestionId ? p.stats : st)),
      };
    }
    case 'LEADERBOARD_UPDATE': {
      const p = env.payload as ServerEnvelope<'LEADERBOARD_UPDATE'>['payload'];
      const leaderboard = applyLeaderboardChanges(s.leaderboard, p.changes, p.removed);
      return { ...s, leaderboard };
    }
    case 'LEADERBOARD_SNAPSHOT': {
      const p = env.payload as ServerEnvelope<'LEADERBOARD_SNAPSHOT'>['payload'];
      return { ...s, leaderboard: p.entries };
    }
    case 'PRESENTATION_UPDATE': {
      const p = env.payload as ServerEnvelope<'PRESENTATION_UPDATE'>['payload'];
      return { ...s, presentation: { view: p.view, sessionQuestionId: p.sessionQuestionId } };
    }
    case 'SCOREBOARD_SETTINGS': {
      const p = env.payload as ServerEnvelope<'SCOREBOARD_SETTINGS'>['payload'];
      return { ...s, scoreboard: p, settings: { ...s.settings, scoreboard: p } };
    }
    default:
      return s;
  }
}

/* ------------------------------------------------------------------ scoreboard / presentation */

export function boardReducer(s: ScoreboardSessionState | null, env: Env): ScoreboardSessionState | null {
  if (env.type === 'SESSION_STATE') {
    const p = env.payload as ScoreboardSessionState;
    return p.role === 'SCOREBOARD' ? p : s;
  }
  if (!s) return s;
  switch (env.type) {
    case 'LEADERBOARD_UPDATE': {
      const p = env.payload as ServerEnvelope<'LEADERBOARD_UPDATE'>['payload'];
      return { ...s, leaderboard: applyLeaderboardChanges(s.leaderboard, p.changes, p.removed) };
    }
    case 'LEADERBOARD_SNAPSHOT': {
      const p = env.payload as ServerEnvelope<'LEADERBOARD_SNAPSHOT'>['payload'];
      return { ...s, leaderboard: p.entries, scoreboard: { visibility: p.visibility, visible: p.visible } };
    }
    case 'SCOREBOARD_SETTINGS':
      return { ...s, scoreboard: env.payload as ScoreboardSessionState['scoreboard'] };
    case 'PRESENTATION_UPDATE': {
      const p = env.payload as ServerEnvelope<'PRESENTATION_UPDATE'>['payload'];
      return { ...s, presentation: { view: p.view, sessionQuestionId: p.sessionQuestionId }, presentationContent: p.content };
    }
    case 'PARTICIPANT_JOIN':
    case 'PARTICIPANT_LEAVE': {
      const p = env.payload as { participantCount: number };
      return { ...s, participantCount: p.participantCount };
    }
    case 'SESSION_STATE_CHANGE':
    case 'SESSION_START':
    case 'SESSION_PAUSE':
    case 'SESSION_END': {
      const p = env.payload as { state: ScoreboardSessionState['state']; timing: ScoreboardSessionState['timing'] };
      return { ...s, state: p.state, timing: p.timing };
    }
    case 'SESSION_RESUME': {
      const p = env.payload as ServerEnvelope<'SESSION_RESUME'>['payload'];
      return { ...s, state: p.state, timing: p.timing, questionDeadlineAt: p.questionDeadlineAt };
    }
    case 'QUESTION_PREPARE': {
      const p = env.payload as ServerEnvelope<'QUESTION_PREPARE'>['payload'];
      return { ...s, currentSessionQuestionId: p.sessionQuestionId, currentPhase: 'PREPARE', questionOpensAt: p.opensAt, questionDeadlineAt: null };
    }
    case 'QUESTION_START': {
      const p = env.payload as ServerEnvelope<'QUESTION_START'>['payload'];
      return { ...s, currentSessionQuestionId: p.sessionQuestionId, currentPhase: 'ACTIVE', questionDeadlineAt: p.deadlineAt };
    }
    case 'QUESTION_END':
      return { ...s, currentPhase: 'LOCKED' };
    case 'QUESTION_RESULT':
      return { ...s, currentPhase: 'RESULT' };
    case 'DEADLINE_UPDATE': {
      const p = env.payload as ServerEnvelope<'DEADLINE_UPDATE'>['payload'];
      return { ...s, timing: { ...s.timing, deadlineAt: p.sessionDeadlineAt }, questionDeadlineAt: p.questionDeadlineAt };
    }
    default:
      return s;
  }
}
