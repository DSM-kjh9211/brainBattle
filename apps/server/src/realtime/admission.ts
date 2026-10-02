import { AppError, isJoinableState, type ParticipantStatus, type SessionSettings, type SessionState } from '@brainbattle/shared';

export interface AdmissionSnapshot {
  state: SessionState;
  settings: SessionSettings;
  participantCount: number;
  accountStatus?: ParticipantStatus | null;
}

type MemberCheck = (classroomId: string, userId: string) => Promise<boolean>;

/** The same restrictions apply to read-only preflight and the authoritative WebSocket join. */
export async function checkNewStudentAdmission(snapshot: AdmissionSnapshot, user: { id: string } | null | undefined, isMember: MemberCheck): Promise<void> {
  const st = snapshot.settings.join;
  if (!isJoinableState(snapshot.state, st.allowLateJoin)) {
    throw new AppError('SESSION_CLOSED', `session is not accepting participants (${snapshot.state})`);
  }
  if ((st.requireLogin || st.classroomId || !st.allowGuests) && !user) throw new AppError('LOGIN_REQUIRED', 'login required to join');
  if (st.classroomId && !(await isMember(st.classroomId, user!.id))) {
    throw new AppError('NOT_IN_CLASSROOM', 'only students of the class may join');
  }
  if (snapshot.participantCount >= st.maxParticipants) throw new AppError('SESSION_FULL', 'session is full');
}

/** The nickname dialog offers account and guest joining; accept if either option is available. */
export async function checkStudentAdmission(snapshot: AdmissionSnapshot, user: { id: string } | null | undefined, isMember: MemberCheck): Promise<void> {
  try {
    if (user && snapshot.accountStatus) {
      if (snapshot.accountStatus === 'KICKED') throw new AppError('KICKED', 'you were removed from this session');
      return;
    }
    await checkNewStudentAdmission(snapshot, user, isMember);
  } catch (e) {
    if (user) {
      try { await checkNewStudentAdmission(snapshot, null, isMember); return; }
      catch { /* Preserve the account-specific reason when neither option is available. */ }
    }
    throw e;
  }
}
