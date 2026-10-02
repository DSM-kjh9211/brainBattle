import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import type { PresetName, QuestionSetDTO, SessionSettings, SessionSettingsPatch, SettingsWarning } from '@brainbattle/shared';
import { api, ApiError } from '../../core/api';
import { TeacherLayout } from './TeacherLayout';

const PRESETS: { id: PresetName; name: string; desc: string }[] = [
  { id: 'LIVE_QUIZ', name: 'Live Quiz', desc: '디지털 문제 · 동시 진행 · 속도 점수 · 실시간 점수판' },
  { id: 'PAPER_BATTLE', name: 'Paper Battle', desc: '종이 문제지 · 자유 진행 · 배점 기반 · 실시간 점수판' },
  { id: 'EXAM', name: 'Exam', desc: '자유 진행 · 답안 수정 가능 · 순위 비공개 · 종료 후 결과 공개' },
  { id: 'CUSTOM', name: '사용자 정의', desc: '문제 세트의 기본 설정에서 시작' },
];

const VIS_LABEL: Record<string, string> = {
  FULL: '전체 순위',
  TOP_10: 'Top 10',
  TOP_5: 'Top 5',
  TOP_3: 'Top 3',
  SELF_ONLY: '개인 점수만',
  SCORES_ONLY: '점수만 표시',
  HIDE_RANK: '순위 숨김',
  PRIVATE: '완전 비공개',
};

export default function NewSession() {
  const [params] = useSearchParams();
  const nav = useNavigate();
  const [sets, setSets] = useState<QuestionSetDTO[]>([]);
  const [setId, setSetId] = useState(params.get('set') ?? '');
  const [preset, setPreset] = useState<PresetName>('PAPER_BATTLE');
  const [patch, setPatch] = useState<SessionSettingsPatch>({});
  const [settings, setSettings] = useState<SessionSettings | null>(null);
  const [warnings, setWarnings] = useState<SettingsWarning[]>([]);
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => void api<QuestionSetDTO[]>('GET', '/api/question-sets').then((s) => {
    setSets(s);
    if (!setId && s[0]) setSetId(s[0].id);
  }), []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    void api<{ settings: SessionSettings; warnings: SettingsWarning[] }>('POST', '/api/settings/preview', { preset, settings: patch })
      .then((r) => {
        setSettings(r.settings);
        setWarnings(r.warnings);
      })
      .catch(() => undefined);
  }, [preset, patch]);

  const up = <K extends keyof SessionSettingsPatch>(k: K, v: SessionSettingsPatch[K]) => setPatch((p) => ({ ...p, [k]: v }));
  const upNested = <K extends 'join' | 'scoreboard' | 'ranking' | 'timing' | 'speed'>(k: K, v: Partial<NonNullable<SessionSettingsPatch[K]>>) =>
    setPatch((p) => ({ ...p, [k]: { ...(p[k] as object), ...v } }));

  const create = async () => {
    setError(null);
    try {
      const s = await api<{ id: string }>('POST', '/api/sessions', { questionSetId: setId, preset, title: title || undefined, settings: patch });
      nav(`/teacher/sessions/${s.id}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    }
  };

  const st = settings;
  return (
    <TeacherLayout title="새 세션">
      <div className="panel">
        <div className="form-grid">
          <label>
            문제 세트
            <select className="input" value={setId} onChange={(e) => setSetId(e.target.value)}>
              {sets.map((s) => (
                <option key={s.id} value={s.id}>{s.title} ({s.questionCount}문항)</option>
              ))}
            </select>
          </label>
          <label>
            세션 제목 (선택)
            <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
        </div>
        <div className="preset-grid">
          {PRESETS.map((p) => (
            <button
              key={p.id}
              className={`preset ${preset === p.id ? 'active' : ''}`}
              onClick={() => {
                setPreset(p.id);
                setPatch({});
              }}
            >
              <b>{p.name}</b>
              <span>{p.desc}</span>
            </button>
          ))}
        </div>
      </div>

      {st && (
        <div className="panel settings">
          <details className="disclosure">
            <summary>세부 설정</summary>
            <div className="form-grid">
              <label>
                문제 제공
                <select className="input" value={st.deliveryMode} onChange={(e) => up('deliveryMode', e.target.value as never)}>
                  <option value="DIGITAL">디지털 문제</option>
                  <option value="PAPER">종이/답안만</option>
                </select>
              </label>
              <label>
                진행 방식
                <select className="input" value={st.progressMode} onChange={(e) => up('progressMode', e.target.value as never)}>
                  <option value="SYNCHRONIZED">동시 진행 (교사가 문제 제어)</option>
                  <option value="FREE">자유 진행 (학생이 선택)</option>
                </select>
              </label>
              <label>
                점수 정책
                <select className="input" value={st.scoringMode} onChange={(e) => up('scoringMode', e.target.value as never)}>
                  <option value="POINT_BASED">배점 합산</option>
                  <option value="CORRECT_COUNT">정답 개수</option>
                  <option value="ACCURACY_SPEED">정답 + 속도</option>
                  <option value="CUSTOM">사용자 정의(확장)</option>
                </select>
              </label>
              <label>
                답안 수정
                <select className="input" value={st.editPolicy} onChange={(e) => up('editPolicy', e.target.value as never)}>
                  <option value="ALLOW">수정 허용</option>
                  <option value="NO_EDIT">제출 후 수정 불가</option>
                  <option value="UNTIL_SESSION_END">세션 종료 전까지</option>
                  <option value="UNTIL_QUESTION_END">문제 종료 전까지</option>
                </select>
              </label>
              <label>
                정답 공개
                <select className="input" value={st.revealPolicy} onChange={(e) => up('revealPolicy', e.target.value as never)}>
                  <option value="IMMEDIATE">즉시 (정오 표시)</option>
                  <option value="AFTER_QUESTION">문제 종료 후</option>
                  <option value="AFTER_SESSION">결과 공개 시</option>
                  <option value="NEVER">공개 안 함</option>
                </select>
              </label>
              <label>
                점수판 공개
                <select className="input" value={st.scoreboard.visibility} onChange={(e) => upNested('scoreboard', { visibility: e.target.value as never })}>
                  {Object.entries(VIS_LABEL).map(([k, v]) => (
                    <option key={k} value={k}>{v}</option>
                  ))}
                </select>
              </label>
              <label>
                세션 제한 시간(분)
                <input
                  className="input"
                  type="number"
                  min={1}
                  placeholder="없음"
                  value={st.timing.sessionTimeLimitSec ? st.timing.sessionTimeLimitSec / 60 : ''}
                  onChange={(e) => upNested('timing', { sessionTimeLimitSec: e.target.value === '' ? null : Math.round(Number(e.target.value) * 60) })}
                />
              </label>
              <label>
                문제 기본 제한(초, 동시 진행)
                <input
                  className="input"
                  type="number"
                  min={3}
                  placeholder="없음"
                  value={st.timing.defaultQuestionTimeLimitSec ?? ''}
                  onChange={(e) => upNested('timing', { defaultQuestionTimeLimitSec: e.target.value === '' ? null : Number(e.target.value) })}
                />
              </label>
              <label>
                문제 시작 카운트다운(초)
                <input className="input" type="number" min={0} max={30} value={st.timing.prepareCountdownSec} onChange={(e) => upNested('timing', { prepareCountdownSec: Number(e.target.value) })} />
              </label>
              <label>
                최대 인원
                <input className="input" type="number" min={1} value={st.join.maxParticipants} onChange={(e) => upNested('join', { maxParticipants: Number(e.target.value) })} />
              </label>
              <label>
                참가 코드 형식
                <select className="input" value={st.join.joinCodeFormat} onChange={(e) => upNested('join', { joinCodeFormat: e.target.value as never })}>
                  <option value="NUMERIC_6">숫자 6자리 (728419)</option>
                  <option value="BRAIN_ALNUM">BRAIN-7K2M</option>
                </select>
              </label>
              <label>
                동점자 처리
                <select
                  className="input"
                  value={st.ranking.allowTies ? 'TIES' : st.ranking.tieBreakers.join(',')}
                  onChange={(e) =>
                    e.target.value === 'TIES'
                      ? upNested('ranking', { allowTies: true, tieBreakers: [] })
                      : upNested('ranking', { allowTies: false, tieBreakers: e.target.value.split(',') as never })
                  }
                >
                  <option value="CORRECT_COUNT_DESC,LAST_SCORED_AT_ASC">정답 수 → 먼저 도달</option>
                  <option value="LAST_CORRECT_AT_ASC">마지막 정답 제출 시각</option>
                  <option value="AVG_RESPONSE_MS_ASC">평균 풀이 시간</option>
                  <option value="CORRECT_COUNT_DESC">정답 수 (나머지 동점)</option>
                  <option value="TIES">동점 허용</option>
                </select>
              </label>
            </div>
            <div className="row wrap">
              <label className="checkbox"><input type="checkbox" checked={st.join.allowGuests} onChange={(e) => upNested('join', { allowGuests: e.target.checked })} /> 게스트 참가 허용</label>
              <label className="checkbox"><input type="checkbox" checked={st.join.requireLogin} onChange={(e) => upNested('join', { requireLogin: e.target.checked })} /> 로그인 필수</label>
              <label className="checkbox"><input type="checkbox" checked={st.join.allowDuplicateNicknames} onChange={(e) => upNested('join', { allowDuplicateNicknames: e.target.checked })} /> 중복 닉네임 허용</label>
              <label className="checkbox"><input type="checkbox" checked={st.join.allowLateJoin} onChange={(e) => upNested('join', { allowLateJoin: e.target.checked })} /> 시작 후 참가 허용</label>
              <label className="checkbox"><input type="checkbox" checked={st.scoreboard.visible} onChange={(e) => upNested('scoreboard', { visible: e.target.checked })} /> 점수판 표시</label>
              <label className="checkbox"><input type="checkbox" checked={st.releaseResultsOnEnd} onChange={(e) => up('releaseResultsOnEnd', e.target.checked)} /> 종료 시 결과 자동 공개</label>
            </div>
          </details>
          {warnings.map((w) => (
            <p key={w.code} className="warning">⚠ {w.message}</p>
          ))}
        </div>
      )}
      {error && <p className="error">{error}</p>}
      <button className="btn primary big" disabled={!setId} onClick={() => void create()}>세션 만들기</button>
    </TeacherLayout>
  );
}
