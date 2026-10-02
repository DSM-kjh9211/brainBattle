/** Run with node --import tsx apps/web/test/ux.smoke.ts.
 * Supply PLAYWRIGHT_MODULE if Playwright is installed outside this checkout.
 * Uses an isolated in-memory server and an installed Edge browser; no production data.
 */
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { startServer, registerTeacher, registerStudent, createSession, Q, TestClient } from '../../server/test/helpers.js';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE ?? 'playwright');
const t = await startServer();
const vite = spawn(process.execPath, [resolve('node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', '5175', '--strictPort'], {
  cwd: resolve('apps/web'), env: { ...process.env, BRAINBATTLE_SERVER: t.baseUrl }, stdio: 'pipe', windowsHide: true,
});
let browser: any;
try {
  await new Promise<void>((res, rej) => {
    const timeout = setTimeout(() => rej(new Error('Vite startup timeout')), 15000);
    vite.stdout!.on('data', (data) => { if (data.toString().includes('5175')) { clearTimeout(timeout); res(); } });
    vite.once('exit', () => { clearTimeout(timeout); rej(new Error('Vite exited')); });
  });
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage();
  await page.addInitScript(() => {
    const Original = window.WebSocket;
    (window as any).testSockets = [];
    window.WebSocket = class extends Original {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        (window as any).testSockets.push(this);
      }
    };
  });
  page.on('dialog', () => { throw new Error('Unexpected browser native dialog'); });
  const wait = async (locator: any) => locator.waitFor({ state: 'visible' });
  const open = async (code: string) => {
    await page.locator('#code').fill(code);
    await page.getByRole('button', { name: '참가하기', exact: true }).click();
  };
  await page.goto('http://127.0.0.1:5175');
  for (const width of [320, 375, 1280]) {
    await page.setViewportSize({ width, height: 812 });
    assert.equal(await page.locator('.tagline').textContent(), '실시간 문제 풀이 · 종이 시험 답안 제출 · 실시간 점수판');
    assert.equal(await page.locator('.tagline').evaluate((e: HTMLElement) => getComputedStyle(e).whiteSpace === 'nowrap' && e.scrollWidth <= e.clientWidth), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  }
  await open('INVALID');
  await wait(page.getByText('존재하지 않는 참가 코드입니다.'));
  assert.equal(await page.getByRole('dialog').count(), 0);
  for (const [code, message, status] of [
    ['SESSION_FINISHED', '이미 종료된 세션입니다.', 409],
    ['SESSION_CLOSED', '지금은 참가할 수 없는 세션입니다.', 409],
    ['RATE_LIMITED', '요청이 너무 많습니다. 잠시 후 다시 시도하세요.', 429],
  ] as const) {
    await page.route('**/api/join/check', (route: any) => route.fulfill({ status, json: { error: { code } } }));
    await open('123456');
    await wait(page.getByText(message));
    assert.equal(await page.getByRole('dialog').count(), 0);
    await page.unroute('**/api/join/check');
  }
  await page.route('**/api/join/check', (route: any) => route.abort());
  await open('123456');
  await wait(page.getByText('서버에 연결할 수 없습니다. 잠시 후 다시 시도해 주세요.'));
  assert.equal(await page.getByRole('dialog').count(), 0);
  await page.unroute('**/api/join/check');
  const teacher = await registerTeacher(t);
  const session = await createSession(t, teacher.token, [Q.mc()]);
  const tc = await TestClient.connect(t);
  await tc.joinTeacher(session.id, teacher.token);
  await tc.cmd('TEACHER_OPEN_LOBBY');
  await open(session.joinCode);
  await wait(page.getByRole('dialog'));
  assert.equal(await page.locator('#join-nickname').evaluate((e: HTMLElement) => document.activeElement === e), true);
  assert.equal(await page.getByRole('button', { name: '입장', exact: true }).isDisabled(), true);
  await page.locator('#join-nickname').fill('   ');
  assert.equal(await page.getByRole('button', { name: '입장', exact: true }).isDisabled(), true);
  for (let i = 0; i < 8; i++) { await page.keyboard.press('Tab'); assert.equal(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]')), true); }
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.equal(await page.getByRole('button', { name: '참가하기', exact: true }).evaluate((e: HTMLElement) => document.activeElement === e), true);

  await open(session.joinCode);
  await wait(page.getByRole('dialog'));
  await page.locator('.app-dialog-backdrop').click({ position: { x: 2, y: 2 } });
  assert.equal(await page.getByRole('dialog').count(), 0);
  await page.setViewportSize({ width: 375, height: 812 });
  await open(session.joinCode);
  await wait(page.getByRole('dialog'));
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  mkdirSync(resolve('artifacts/ux'), { recursive: true });
  await page.screenshot({ path: 'artifacts/ux/mobile-dialog.png' });
  await page.locator('#join-nickname').fill('CBT학생');
  await page.keyboard.press('Enter');
  await wait(page.getByText('CBT학생 님, 입장 완료!'));
  const identity = await page.evaluate((code: string) => localStorage.getItem(`bb.identity.${code}`), session.joinCode);
  assert.ok(identity);
  await page.reload();
  await wait(page.getByText('CBT학생 님, 입장 완료!'));
  assert.equal(await page.getByRole('dialog').count(), 0);
  assert.equal(await page.evaluate((code: string) => localStorage.getItem(`bb.identity.${code}`), session.joinCode), identity);
  tc.messages.splice(0, tc.messages.length);
  await page.evaluate(() => (window as any).testSockets.at(-1).close(4000, 'test reconnect'));
  await page.waitForFunction(() => (window as any).testSockets.length > 1 && (window as any).testSockets.at(-1).readyState === 1);
  await wait(page.getByText('연결됨', { exact: true }));
  await tc.waitFor('PARTICIPANT_RECONNECT');
  assert.equal(await page.evaluate((code: string) => localStorage.getItem(`bb.identity.${code}`), session.joinCode), identity);
  const retry = await browser.newPage();
  await retry.goto(`http://127.0.0.1:5175/play/${session.joinCode}`);
  await retry.getByRole('button', { name: '참가하기', exact: true }).click();
  await wait(retry.getByRole('dialog'));
  await retry.locator('#join-nickname').fill('CBT학생');
  await retry.keyboard.press('Enter');
  await wait(retry.getByText('이미 사용 중인 닉네임입니다.'));
  await retry.getByRole('button', { name: '참가하기', exact: true }).click();
  await wait(retry.getByRole('dialog'));
  await retry.locator('#join-nickname').fill('재시도학생');
  await retry.keyboard.press('Enter');
  await wait(retry.getByText('재시도학생 님, 입장 완료!'));
  await retry.close();
  const account = await registerStudent(t);
  await page.evaluate((auth: any) => { localStorage.clear(); localStorage.setItem('bb.auth', JSON.stringify(auth)); }, account);
  await page.goto('http://127.0.0.1:5175');
  await open(session.joinCode);
  await wait(page.getByRole('dialog'));
  assert.equal(await page.getByRole('checkbox').isChecked(), true);
  await page.locator('#join-nickname').fill('계정학생');
  await page.keyboard.press('Enter');
  await wait(page.getByText('계정학생 님, 입장 완료!'));
  const participant = (await t.db.query('SELECT is_guest FROM session_participants WHERE user_id = $1', [account.user.id])).rows[0];
  assert.equal(participant.is_guest, false);
  await page.evaluate((auth: any) => { localStorage.clear(); localStorage.setItem('bb.auth', JSON.stringify(auth)); }, teacher);
  let releaseSets!: () => void; let releaseSessions!: () => void;
  const setsGate = new Promise<void>(res => { releaseSets = res; });
  const sessionsGate = new Promise<void>(res => { releaseSessions = res; });
  await page.route('**/api/question-sets', async (route: any) => { await setsGate; await route.fulfill({ json: [] }); });
  await page.route('**/api/sessions', async (route: any) => { await sessionsGate; await route.fulfill({ json: [] }); });
  await page.goto('http://127.0.0.1:5175/teacher');
  await wait(page.getByRole('heading', { name: '대시보드' }));
  assert.equal(await page.locator('.panel-skeleton').count(), 2);
  await page.screenshot({ path: 'artifacts/ux/dashboard-loading.png' });
  assert.equal(await page.getByText('문제 세트가 없습니다. 새로 만들어 보세요.').count(), 0);
  assert.equal(await page.getByText('아직 진행한 세션이 없습니다.').count(), 0);
  releaseSets();
  await wait(page.getByText('문제 세트가 없습니다. 새로 만들어 보세요.'));
  assert.equal(await page.locator('.panel-skeleton').count(), 1);
  releaseSessions();
  await wait(page.getByText('아직 진행한 세션이 없습니다.'));
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.screenshot({ path: 'artifacts/ux/dashboard.png' });
  await page.getByRole('button', { name: '+ 문제 세트' }).click();
  await wait(page.getByRole('dialog', { name: '문제 세트 만들기' }));
  await page.keyboard.press('Escape');
  await page.goto(`http://127.0.0.1:5175/teacher/sessions/${session.id}`);
  await wait(page.getByRole('button', { name: '■ 종료' }));
  await page.getByRole('button', { name: '■ 종료' }).click();
  await wait(page.getByRole('dialog', { name: '세션을 종료할까요?' }));
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('dialog').count(), 0);
  await page.getByRole('button', { name: '■ 종료' }).click();
  await page.getByRole('dialog').getByRole('button', { name: '종료', exact: true }).click();
  await wait(page.locator('.state-badge').filter({ hasText: /^종료$/ }));
  assert.equal((await t.db.query('SELECT state FROM sessions WHERE id = $1', [session.id])).rows[0].state, 'FINISHED');
  await page.goto('http://127.0.0.1:5175/teacher/questions');
  await page.getByRole('button', { name: '+ 새 문제' }).click();
  await wait(page.getByRole('dialog'));
  await page.locator('input[type=file]').first().setInputFiles({ name: 'oversize.png', mimeType: 'image/png', buffer: Buffer.alloc(700 * 1024) });
  await wait(page.getByRole('dialog', { name: '파일을 첨부할 수 없습니다.' }));
  assert.equal(await page.getByRole('dialog').count(), 2);
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('dialog').count(), 1);
  assert.equal(await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]')), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('dialog').count(), 0);
  await page.unroute('**/api/question-sets');
  await page.unroute('**/api/sessions');
  const sessionResponse = await fetch(`${t.baseUrl}/api/sessions`, { headers: { authorization: `Bearer ${teacher.token}` } });
  const storedSessions = await sessionResponse.json();
  const states = ['CREATED', 'LOBBY', 'READY', 'ACTIVE', 'PAUSED'];
  const sessionRows = [...storedSessions, ...states.map((state) => ({ ...storedSessions[0], id: state, title: `session-${state}`, state }))];
  await page.route('**/api/sessions', (route: any) => route.request().method() === 'GET' ? route.fulfill({ json: sessionRows }) : route.continue());
  let deletes = 0;
  page.on('request', (request: any) => { if (request.method() === 'DELETE') deletes++; });
  const preserved = async () => (await t.db.query(`SELECT
    (SELECT count(*) FROM sessions) AS sessions,
    (SELECT count(*) FROM session_participants) AS participants,
    (SELECT count(*) FROM submissions) AS submissions,
    (SELECT count(*) FROM scores) AS scores,
    (SELECT count(*) FROM session_events) AS events,
    (SELECT count(*) FROM audit_logs) AS audits`)).rows;
  const before = await preserved();
  await page.goto('http://127.0.0.1:5175/teacher');
  const finished = page.locator('.finished-sessions');
  await wait(finished.locator('summary'));
  assert.equal(await finished.getAttribute('open'), null);
  assert.equal(await finished.locator('.card-title').isVisible(), false);
  for (const state of states) await wait(page.getByRole('link', { name: `session-${state}`, exact: true }));
  await finished.locator('summary').click();
  await wait(finished.locator('.card-title'));
  await finished.locator('summary').click();
  assert.equal(await finished.locator('.card-title').isVisible(), false);
  for (const state of states) await wait(page.getByRole('link', { name: `session-${state}`, exact: true }));
  assert.equal(deletes, 0);
  assert.deepEqual(await preserved(), before);
  await finished.locator('summary').click();
  await finished.getByRole('link', { name: '결과', exact: true }).click();
  await wait(page.getByRole('heading', { name: '결과 분석' }));
  await page.goto('http://127.0.0.1:5175/teacher/sessions/new');
  const advanced = page.locator('.settings details');
  await wait(advanced.locator('summary'));
  assert.equal(await advanced.getAttribute('open'), null);
  assert.equal(await advanced.locator('select').first().isVisible(), false);
  await wait(page.locator('.form-grid select').first());
  await page.getByRole('button', { name: /Live Quiz/ }).click();
  await advanced.locator('summary').click();
  await page.waitForFunction(() => (document.querySelector('.settings select') as HTMLSelectElement)?.value === 'DIGITAL');
  await Promise.all([
    page.waitForResponse((r: any) => r.url().endsWith('/api/settings/preview') && r.ok()),
    page.getByLabel('최대 인원', { exact: true }).fill('23'),
  ]);
  await Promise.all([
    page.waitForResponse((r: any) => r.url().endsWith('/api/settings/preview') && r.ok()),
    advanced.locator('select').nth(1).selectOption('FREE'),
  ]);
  await advanced.locator('summary').click();
  assert.equal(await page.getByLabel('최대 인원', { exact: true }).isVisible(), false);
  await wait(page.locator('.settings .warning').first());
  await advanced.locator('summary').click();
  assert.equal(await page.getByLabel('최대 인원', { exact: true }).inputValue(), '23');
  await page.getByRole('button', { name: /^Exam/ }).click();
  await page.waitForFunction(() => (document.querySelector('.settings select') as HTMLSelectElement)?.value === 'PAPER');
  assert.notEqual(await page.getByLabel('최대 인원', { exact: true }).inputValue(), '23');
  await page.getByRole('button', { name: /Live Quiz/ }).click();
  await page.waitForFunction(() => (document.querySelector('.settings select') as HTMLSelectElement)?.value === 'DIGITAL');
  await Promise.all([
    page.waitForResponse((r: any) => r.url().endsWith('/api/settings/preview') && r.ok()),
    page.getByLabel('최대 인원', { exact: true }).fill('23'),
  ]);
  await advanced.locator('summary').click();
  await page.setViewportSize({ width: 375, height: 812 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: 'artifacts/ux/new-session-collapsed.png' });
  const created = page.waitForResponse((r: any) => r.url().endsWith('/api/sessions') && r.request().method() === 'POST');
  await page.getByRole('button', { name: '세션 만들기', exact: true }).click();
  const createdSession = await (await created).json();
  assert.equal(createdSession.settings.join.maxParticipants, 23);
  assert.equal(createdSession.preset, 'LIVE_QUIZ');
  console.log('PASS: single-line tagline without overflow (320/375/1280), FINISHED hide/show with ongoing visible and DB/results preserved, collapsed settings/preset reset/custom values/warnings/mobile/create');
  console.log('PASS: join errors, nickname, keyboard/focus, mobile, refresh/resume, actual WebSocket reconnect, duplicate retry, account join, independent dashboard loading/empty, Input/Confirm/nested Notice dialogs');
} finally {
  if (browser) await browser.close();
  vite.kill();
  await t.close();
}
