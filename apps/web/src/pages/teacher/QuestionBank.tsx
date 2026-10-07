import { useEffect, useState } from 'react';
import type { QuestionDTO } from '@brainbattle/shared';
import { api } from '../../core/api';
import { AiButton, AiGenerateModal } from './AiAssist';
import { QuestionEditor, TYPE_LABEL } from './QuestionEditor';
import { useDialogs } from '../../components/Dialog';
import { TeacherLayout } from './TeacherLayout';

export default function QuestionBank() {
  const dialogs = useDialogs();
  const [items, setItems] = useState<QuestionDTO[]>([]);
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<QuestionDTO | null | undefined>(undefined);
  const [aiOpen, setAiOpen] = useState(false);
  const load = () => void api<QuestionDTO[]>('GET', `/api/questions?search=${encodeURIComponent(search)}`).then(setItems);
  useEffect(load, [search]);

  return (
    <TeacherLayout title="문제 은행" actions={
        <>
          <AiButton onClick={() => setAiOpen(true)}>AI 출제</AiButton>
          <button className="btn primary" onClick={() => setEditing(null)}>+ 새 문제</button>
        </>
      }>
      <input className="input" placeholder="제목/번호 검색" value={search} onChange={(e) => setSearch(e.target.value)} />
      <table className="table">
        <thead>
          <tr>
            <th>번호</th>
            <th>유형</th>
            <th>제목</th>
            <th>방식</th>
            <th>배점</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {items.map((q) => (
            <tr key={q.id}>
              <td>{q.displayNumber ?? '-'}</td>
              <td>{TYPE_LABEL[q.type]}</td>
              <td>{q.title ?? <span className="muted">(답안 전용)</span>}</td>
              <td>{q.deliveryMode === 'PAPER' ? '종이' : '디지털'}</td>
              <td>{q.score}</td>
              <td className="row">
                <button className="btn small" onClick={() => setEditing(q)}>수정</button>
                <button
                  className="btn small"
                  onClick={async () => {
                    await api('POST', `/api/questions/${q.id}/duplicate`);
                    load();
                  }}
                >
                  복제
                </button>
                <button
                  className="btn small danger"
                  onClick={async () => {
                    if (!await dialogs.confirm({ title: '문제를 삭제할까요?', description: '진행 중이거나 종료된 세션에는 영향을 주지 않습니다. 이 작업은 되돌릴 수 없습니다.', confirmText: '삭제', destructive: true })) return;
                    await api('DELETE', `/api/questions/${q.id}`);
                    load();
                  }}
                >
                  삭제
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {editing !== undefined && (
        <QuestionEditor
          question={editing}
          onClose={() => setEditing(undefined)}
          onSaved={() => {
            setEditing(undefined);
            load();
          }}
        />
      )}
      {aiOpen && (
        <AiGenerateModal
          mode="questions"
          onClose={() => setAiOpen(false)}
          onSave={async (qs) => {
            await api('POST', '/api/questions/batch', { questions: qs });
            setAiOpen(false);
            load();
          }}
        />
      )}
    </TeacherLayout>
  );
}
