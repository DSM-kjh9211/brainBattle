/**
 * BrainBattle Desktop (Teacher-first) — Electron main process.
 *
 * The desktop app is a thin, secure shell around the SAME web client served by the BrainBattle
 * server, so UI and business logic are shared 1:1 with the browser version. It adds what a
 * browser cannot do well for a teacher in a classroom:
 *   - a separate Presentation/Scoreboard window placed full-screen on the projector (display 2)
 *   - follows display hot-plug (projector connected later)
 *   - full-screen teacher dashboard, native menu without shortcut conflicts
 *   - Ctrl+digit shortcuts in the math editor (browsers reserve them for tab switching)
 *
 * Security: contextIsolation + sandbox, no Node in renderers, navigation restricted to the
 * configured BrainBattle origin, IPC arguments validated.
 */
const { app, BrowserWindow, Menu, ipcMain, screen, shell, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

const isDev = !app.isPackaged;
const configFile = () => path.join(app.getPath('userData'), 'config.json');

function loadConfig() {
  const fromEnv = process.env.BRAINBATTLE_URL;
  let fileCfg = {};
  try {
    fileCfg = JSON.parse(fs.readFileSync(configFile(), 'utf8'));
  } catch {
    /* first run */
  }
  const serverUrl = (fromEnv || fileCfg.serverUrl || (isDev ? 'http://localhost:5173' : 'http://localhost:4000')).replace(/\/$/, '');
  return { serverUrl };
}

function saveConfig(cfg) {
  fs.mkdirSync(path.dirname(configFile()), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify(cfg, null, 2));
}

let config;
let mainWindow = null;
let presentationWindow = null;

const origin = () => new URL(config.serverUrl).origin;
const isAppUrl = (u) => {
  try {
    return new URL(u).origin === origin();
  } catch {
    return false;
  }
};

function secureWebPreferences() {
  return {
    preload: path.join(__dirname, 'preload.cjs'),
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    webSecurity: true,
    spellcheck: false,
  };
}

function hardenContents(contents) {
  contents.on('will-navigate', (e, url) => {
    if (!isAppUrl(url)) {
      e.preventDefault();
      if (/^https?:/.test(url)) void shell.openExternal(url);
    }
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (isAppUrl(url) && new URL(url).pathname.startsWith('/present/')) {
      void openPresentation(url);
      return { action: 'deny' };
    }
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.session.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'fullscreen' || permission === 'clipboard-sanitized-write'));
}

function externalDisplay() {
  const primary = screen.getPrimaryDisplay();
  return screen.getAllDisplays().find((d) => d.id !== primary.id) ?? null;
}

async function openPresentation(url) {
  if (!isAppUrl(url)) throw new Error('presentation URL must belong to the BrainBattle server');
  const target = externalDisplay();
  if (presentationWindow && !presentationWindow.isDestroyed()) {
    await presentationWindow.loadURL(url);
    presentationWindow.show();
    return { displayId: target?.id ?? null, external: !!target };
  }
  const bounds = (target ?? screen.getPrimaryDisplay()).bounds;
  presentationWindow = new BrowserWindow({
    x: bounds.x + 40,
    y: bounds.y + 40,
    width: Math.min(1600, bounds.width - 80),
    height: Math.min(900, bounds.height - 80),
    title: 'BrainBattle — 발표 화면',
    backgroundColor: '#11142c',
    autoHideMenuBar: true,
    fullscreen: !!target, // projector: full screen on display 2
    webPreferences: secureWebPreferences(),
  });
  hardenContents(presentationWindow.webContents);
  presentationWindow.on('closed', () => (presentationWindow = null));
  await presentationWindow.loadURL(url);
  return { displayId: target?.id ?? null, external: !!target };
}

function movePresentationToNextDisplay() {
  if (!presentationWindow || presentationWindow.isDestroyed()) return;
  const displays = screen.getAllDisplays();
  const current = screen.getDisplayMatching(presentationWindow.getBounds());
  const idx = displays.findIndex((d) => d.id === current.id);
  const next = displays[(idx + 1) % displays.length];
  const wasFull = presentationWindow.isFullScreen();
  if (wasFull) presentationWindow.setFullScreen(false);
  presentationWindow.setBounds({ x: next.bounds.x + 40, y: next.bounds.y + 40, width: 1280, height: 720 });
  if (wasFull || next.id !== screen.getPrimaryDisplay().id) setTimeout(() => presentationWindow?.setFullScreen(true), 150);
}

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    title: 'BrainBattle',
    backgroundColor: '#f4f5fb',
    webPreferences: secureWebPreferences(),
  });
  hardenContents(mainWindow.webContents);
  mainWindow.on('closed', () => {
    mainWindow = null;
    presentationWindow?.close();
  });
  mainWindow.webContents.on('did-fail-load', async (_e, _code, desc) => {
    const r = await dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: '서버에 연결할 수 없습니다',
      message: `${config.serverUrl} 에 연결하지 못했습니다 (${desc}).`,
      buttons: ['다시 시도', '서버 주소 변경', '종료'],
    });
    if (r.response === 0) void mainWindow.loadURL(`${config.serverUrl}/teacher`);
    else if (r.response === 1) promptServerUrl();
    else app.quit();
  });
  void mainWindow.loadURL(`${config.serverUrl}/teacher`);
}

async function promptServerUrl() {
  // minimal, dependency-free prompt: a tiny sandboxed window with a form
  const win = new BrowserWindow({ width: 460, height: 220, parent: mainWindow ?? undefined, modal: !!mainWindow, resizable: false, title: '서버 주소', webPreferences: { sandbox: true, contextIsolation: true, preload: path.join(__dirname, 'preload.cjs') } });
  win.setMenu(null);
  const html = `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;padding:16px">
    <form id="f"><label>BrainBattle 서버 주소<br><input id="u" style="width:100%;padding:8px;margin:8px 0" value="${config.serverUrl.replace(/"/g, '')}"></label>
    <button>저장</button></form>
    <script>document.getElementById('f').onsubmit=(e)=>{e.preventDefault();window.brainbattleDesktop.setServerUrl(document.getElementById('u').value)}</script></body>`;
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
}

function buildMenu() {
  // NOTE: no Ctrl+R / Ctrl+P / Ctrl+digit accelerators — those belong to the math editor.
  const template = [
    {
      label: 'BrainBattle',
      submenu: [
        { label: '서버 주소 변경…', click: () => void promptServerUrl() },
        { type: 'separator' },
        { role: 'quit', label: '종료' },
      ],
    },
    { label: '편집', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    {
      label: '보기',
      submenu: [
        { label: '새로고침', accelerator: 'F5', click: () => BrowserWindow.getFocusedWindow()?.webContents.reload() },
        { label: '전체 화면', accelerator: 'F11', click: () => mainWindow?.setFullScreen(!mainWindow.isFullScreen()) },
        { label: '발표 화면을 다음 모니터로', accelerator: 'CmdOrCtrl+Shift+M', click: movePresentationToNextDisplay },
        { label: '발표 화면 닫기', click: () => presentationWindow?.close() },
        { type: 'separator' },
        { role: 'zoomIn', label: '확대' },
        { role: 'zoomOut', label: '축소' },
        { role: 'resetZoom', label: '원래 크기' },
        ...(isDev ? [{ label: '개발자 도구', accelerator: 'F12', click: () => BrowserWindow.getFocusedWindow()?.webContents.toggleDevTools() }] : []),
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ------------------------------------------------------------------ IPC (validated) */
ipcMain.handle('bb:openPresentation', (_e, url) => {
  if (typeof url !== 'string') throw new Error('invalid url');
  return openPresentation(url);
});
ipcMain.handle('bb:closePresentation', () => presentationWindow?.close());
ipcMain.handle('bb:listDisplays', () =>
  screen.getAllDisplays().map((d) => ({ id: d.id, label: d.label || `Display ${d.id}`, primary: d.id === screen.getPrimaryDisplay().id, bounds: { width: d.bounds.width, height: d.bounds.height } })),
);
ipcMain.handle('bb:toggleFullscreen', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w) return false;
  w.setFullScreen(!w.isFullScreen());
  return w.isFullScreen();
});
ipcMain.handle('bb:setServerUrl', (e, url) => {
  // only the local settings prompt may change the server (never a page served by a server)
  if (!e.senderFrame?.url.startsWith('data:')) return false;
  try {
    const u = new URL(String(url));
    if (!/^https?:$/.test(u.protocol)) throw new Error('http(s) only');
    config = { ...config, serverUrl: u.origin };
    saveConfig(config);
    BrowserWindow.fromWebContents(e.sender)?.close();
    void mainWindow?.loadURL(`${config.serverUrl}/teacher`);
    return true;
  } catch {
    return false;
  }
});

/* ------------------------------------------------------------------ lifecycle */
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  app.whenReady().then(() => {
    config = loadConfig();
    buildMenu();
    createMainWindow();
    // projector plugged in during class: move the presentation window onto it
    screen.on('display-added', () => {
      const ext = externalDisplay();
      if (ext && presentationWindow && !presentationWindow.isDestroyed()) {
        presentationWindow.setBounds({ x: ext.bounds.x + 40, y: ext.bounds.y + 40, width: 1280, height: 720 });
        setTimeout(() => presentationWindow?.setFullScreen(true), 150);
      }
    });
    app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && createMainWindow());
  });
  app.on('window-all-closed', () => process.platform !== 'darwin' && app.quit());
}
