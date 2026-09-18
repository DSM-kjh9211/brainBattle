import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { arrayMove, SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { QuestionDTO, QuestionSetDTO, QuestionSetItemDTO } from '@brainbattle/shared';
import { api } from '../../core/api';
import { ContentBlocks, CorrectAnswerView } from '../../components/Content';
import { Modal } from '../../components/common';
import { QuestionEditor, TYPE_LABEL } from './QuestionEditor';
import { TeacherLayout } from './TeacherLayout';

function SortableRow({
  item,
  q,
  onEdit,
  onDuplicate,
  onRemove,
  onPatch,
}: {
  item: QuestionSetItemDTO;
  q: QuestionDTO | undefined;
  onEdit: () => void;
  onDuplicate: () => void;
  onRemove: () => void;
  onPatch: (p: { displayNumber?: string | null; scoreOverride?: number | null }) => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id });
  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.6 : 1 }}
      className="set-row"
    >
      <button className="drag-handle" {...attributes} {...listeners} aria-label="순서 변경 (드래그 또는 스페이스+방향키)">⠿</button>
      <input
        className="input num-input"
        defaultValue={item.displayNumberOverride ?? ''}
        placeholder={item.displayNumber}
        title="표시 번호 (비우면 문제 기본값/순번)"
        onBlur={(e) => {
          const v = e.target.value.trim();
          if ((item.displayNumberOverride ?? '') !== v) onPatch({ displayNumber: v || null });
        }}
      />
      <span className="set-type">{q ? TYPE_LABEL[q.type] : '…'}</span>
      <span className="set-title">{q?.title ?? <span className="muted">(답안 전용 — {q?.deliveryMode === 'PAPER' ? '종이' : '디지털'})</span>}</span>
      <input
        className="input score-input"
        type="number"
        min={0}
        defaultValue={item.scoreOverride ?? ''}
        placeholder={String(q?.score ?? '')}
        title="배점 (비우면 문제 기본 배점)"
        onBlur={(e) => {
          const v = e.target.value === '' ? null : Number(e.target.value);
          if (v !== item.scoreOverride) onPatch({ scoreOverride: v });
        }}
      />
      <button className="btn small" onClick={onEdit}>수정</button>
      <button className="btn small" onClick={onDuplicate}>복제</button>
      <button className="btn small danger" onClick={onRemove}>제거</button>
    </li>
  );
}

export default function SetEditor() {
  const { id = '' } = useParams();
  const nav = useNavigate();
  const [set, setSet] = useState<QuestionSetDTO | null>(null);
  const [questions, setQuestions] = useState<Map<string, QuestionDTO>>(new Map());
  const [editing, setEditing] = useState<QuestionDTO | null | undefined>(undefined);
  const [picker, setPicker] = useState(false);
  const [preview, setPreview] = useState(false);
  const sensors = useSensors(useSensor(PointerSensor), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));

  const refreshQuestions = async (s: QuestionSetDTO) => {
    const p = await api<{ questions: QuestionDTO[] }>('GET', `/api/question-sets/${s.id}/preview`);
    setQuestions(new Map(p.questions.map((q) => [q.id, q])));
  };
  const apply = (s: QuestionSetDTO) => {
    setSet(s);
    void refreshQuestions(s);
  };
  useEffect(() => {
    void api<QuestionSetDTO>('GET', `/api/question-sets/${id}`).then(apply);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const onDragEnd = async (e: DragEndEvent) => {
    if (!set || !e.over || e.active.id === e.over.id) return;
    const oldIndex = set.items.findIndex((i) => i.id === e.active.id);
    const newIndex = set.items.findIndex((i) => i.id === e.over!.id);
    const items = arrayMove(set.items, oldIndex, newIndex);
    setSet({ ...set, items }); // optimistic
    apply(await api<QuestionSetDTO>('PUT', `/api/question-sets/${set.id}/order`, { itemIds: items.map((i) => i.id) }));
  };

  const saveMeta = async (patch: Partial<QuestionSetDTO>) => {
    if (!set) return;
    const next = { ...set, ...patch };
    apply(
      await api<QuestionSetDTO>('PUT', `/api/question-sets/${set.id}`, {
        title: next.title,
        description: next.description,
        deliveryMode: next.deliveryMode,
        progressMode: next.progressMode,
        scoringMode: next.scoringMode,
      }),
    );
  };

  if (!set) return <TeacherLayout><p>불러오는 중…</p></TeacherLayout>;

  return (
    <TeacherLayout
      title={set.title}
      actions={
        <>
          <button className="btn" onClick={() => setPreview(true)}>미리보기</button>
          <button className="btn" onClick={() => setPicker(true)}>은행에서 추가</button>
          <button className="btn" onClick={() => setEditing(null)}>+ 새 문제</button>
          <button className="btn primary" disabled={set.items.length === 0} onClick={() => nav(`/teacher/sessions/new?set=${set.id}`)}>세션 시작 →</button>
        </>
      }
    >
      <div className="panel form-grid">
        <label>
          제목
          <input className="input" defaultValue={set.title} onBlur={(e) => e.target.value !== set.title && void saveMeta({ title: e.target.value })} />
        </label>
        <label>
          기본 제공 방식
          <select className="input" value={set.deliveryMode} onChange={(e) => void saveMeta({ deliveryMode: e.target.value as never })}>
            <option value="DIGITAL">디지털</option>
            <option value="PAPER">종이/답안만</option>
          </select>
        </label>
        <label>
          기본 진행 방식
          <select className="input" value={set.progressMode} onChange={(e) => void saveMeta({ progressMode: e.target.value as never })}>
            <option value="SYNCHRONIZED">동시 진행</option>
            <option value="FREE">자유 진행</option>
          </select>
        </label>
        <label>
          기본 점수 방식
          <select className="input" value={set.scoringMode} onChange={(e) => void saveMeta({ scoringMode: e.target.value as never })}>
            <option value="POINT_BASED">배점 합산</option>
            <option value="CORRECT_COUNT">정답 개수</option>
            <option value="ACCURACY_SPEED">정답 + 속도</option>
          </select>
        </label>
      </div>

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={(e) => void onDragEnd(e)}>
        <SortableContext items={set.items.map((i) => i.id)} strategy={verticalListSortingStrategy}>
          <ul className="set-list">
            {set.items.map((item) => (
              <SortableRow
                key={item.id}
                item={item}
                q={questions.get(item.questionId)}
                onEdit={() => setEditing(questions.get(item.questionId) ?? null)}
                onDuplicate={async () => apply(await api('POST', `/api/question-sets/${set.id}/items/${item.id}/duplicate`))}
                onRemove={async () => apply(await api('DELETE', `/api/question-sets/${set.id}/items/${item.id}`))}
                onPatch={async (p) => apply(await api('PATCH', `/api/question-sets/${set.id}/items/${item.id}`, p))}
              />
            ))}
          </ul>
        </SortableContext>
      </DndContext>
      {set.items.length === 0 && <p className="muted">문제가 없습니다. "새 문제" 또는 "은행에서 추가"를 사용하세요.</p>}

      {editing !== undefined && (
        <QuestionEditor
          question={editing}
          onClose={() => setEditing(undefined)}
          onSaved={async (q) => {
            setEditing(undefined);
            if (!editing) apply(await api('POST', `/api/question-sets/${set.id}/items`, { questionId: q.id }));
            else void refreshQuestions(set);
          }}
        />
      )}
      {picker && <BankPicker exclude={new Set(set.items.map((i) => i.questionId))} onClose={() => setPicker(false)} onPick={async (qid) => apply(await api('POST', `/api/question-sets/${set.id}/items`, { questionId: qid }))} />}
      {preview && <SetPreview set={set} questions={questions} onClose={() => setPreview(false)} />}
    </TeacherLayout>
  );
}

function BankPicker({ exclude, onClose, onPick }: { exclude: Set<string>; onClose: () => void; onPick: (id: string) => Promise<void> }) {
  const [items, setItems] = useState<QuestionDTO[]>([]);
  const [search, setSearch] = useState('');
  useEffect(() => void api<QuestionDTO[]>('GET', `/api/questions?search=${encodeURIComponent(search)}`).then(setItems), [search]);
  return (
    <Modal title="문제 은행에서 추가" onClose={onClose} wide>
      <input className="input" placeholder="검색" value={search} onChange={(e) => setSearch(e.target.value)} autoFocus />
      <ul className="card-list">
        {items.filter((q) => !exclude.has(q.id)).map((q) => (
          <li key={q.id} className="card-item">
            <span>
              <b>{q.displayNumber ?? '-'}</b> {TYPE_LABEL[q.type]} · {q.title ?? '(답안 전용)'}
            </span>
            <button className="btn small" onClick={() => void onPick(q.id)}>추가</button>
          </li>
        ))}
      </ul>
    </Modal>
  );
}

function SetPreview({ set, questions, onClose }: { set: QuestionSetDTO; questions: Map<string, QuestionDTO>; onClose: () => void }) {
  const [showAnswers, setShowAnswers] = useState(true);
  const list = useMemo(() => set.items.map((i) => ({ item: i, q: questions.get(i.questionId) })), [set, questions]);
  return (
    <Modal title={`미리보기 — ${set.title}`} onClose={onClose} wide>
      <label className="checkbox">
        <input type="checkbox" checked={showAnswers} onChange={(e) => setShowAnswers(e.target.checked)} /> 정답 표시
      </label>
      {list.map(({ item, q }) =>
        q ? (
          <article key={item.id} className="question-card preview">
            <div className="q-head">
              <span className="q-number">문제 {item.displayNumber}</span>
              <span className="muted small">{item.scoreOverride ?? q.score}점 · {TYPE_LABEL[q.type]} · {q.deliveryMode === 'PAPER' ? '종이' : '디지털'}</span>
            </div>
            {q.deliveryMode === 'PAPER' ? (
              <p className="muted">답: [ 입력 ] (문제는 종이로 제공)</p>
            ) : (
              <>
                {q.title && <h3>{q.title}</h3>}
                <ContentBlocks blocks={q.description} />
                {q.choices && (
                  <ol className="preview-choices">
                    {q.choices.map((c) => (
                      <li key={c.id}>
                        {c.label} <ContentBlocks blocks={c.content} />
                      </li>
                    ))}
                  </ol>
                )}
              </>
            )}
            {showAnswers && (
              <p className="reveal">
                정답: <CorrectAnswerView value={q.correctAnswer} choices={q.choices} isLatex={q.type === 'LATEX'} />
              </p>
            )}
          </article>
        ) : null,
      )}
    </Modal>
  );
}
