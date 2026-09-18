import { lazy, Suspense } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider, RequireTeacher } from './core/auth';
import { HomePage } from './pages/Home';
import { PlayPage } from './pages/student/PlayPage';

const LoginPage = lazy(() => import('./pages/teacher/LoginPage'));
const TeacherHome = lazy(() => import('./pages/teacher/TeacherHome'));
const QuestionBank = lazy(() => import('./pages/teacher/QuestionBank'));
const SetEditor = lazy(() => import('./pages/teacher/SetEditor'));
const NewSession = lazy(() => import('./pages/teacher/NewSession'));
const LiveSession = lazy(() => import('./pages/teacher/LiveSession'));
const Results = lazy(() => import('./pages/teacher/Results'));
const PresentPage = lazy(() => import('./pages/present/PresentPage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));

export function App() {
  return (
    <AuthProvider>
      <BrowserRouter>
        <Suspense fallback={<div className="page-loading">불러오는 중…</div>}>
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="/play/:code" element={<PlayPage />} />
            <Route path="/present/:sessionId" element={<PresentPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/teacher/login" element={<LoginPage />} />
            <Route path="/teacher" element={<RequireTeacher><TeacherHome /></RequireTeacher>} />
            <Route path="/teacher/questions" element={<RequireTeacher><QuestionBank /></RequireTeacher>} />
            <Route path="/teacher/sets/:id" element={<RequireTeacher><SetEditor /></RequireTeacher>} />
            <Route path="/teacher/sessions/new" element={<RequireTeacher><NewSession /></RequireTeacher>} />
            <Route path="/teacher/sessions/:id" element={<RequireTeacher><LiveSession /></RequireTeacher>} />
            <Route path="/teacher/sessions/:id/results" element={<RequireTeacher><Results /></RequireTeacher>} />
            <Route path="*" element={<HomePage />} />
          </Routes>
        </Suspense>
      </BrowserRouter>
    </AuthProvider>
  );
}
