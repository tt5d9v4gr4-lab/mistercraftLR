'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const P = require('./src/paths');
const settings = require('./src/settings');
const V = require('./src/versions');
const installer = require('./src/installer');
const loaders = require('./src/loaders');
const javaMod = require('./src/java');
const auth = require('./src/auth');
const launch = require('./src/launch');

let win = null;
let state = 'idle'; // idle | installing | running
let gameProc = null;
let userStopped = false;
let authAbort = null;
const logBuf = [];

// ---------- хранение токенов ----------
settings.setCrypto({
  enc: (s) =>
    safeStorage.isEncryptionAvailable()
      ? 'enc1:' + safeStorage.encryptString(s).toString('base64')
      : 'raw:' + Buffer.from(s, 'utf8').toString('base64'),
  dec: (s) =>
    s.startsWith('enc1:')
      ? safeStorage.decryptString(Buffer.from(s.slice(5), 'base64'))
      : Buffer.from(s.replace(/^raw:/, ''), 'base64').toString('utf8'),
});

// ---------- утилиты ----------
const send = (ch, data) => {
  if (win && !win.isDestroyed()) win.webContents.send(ch, data);
};
const setState = (s) => { state = s; send('state', s); };
const progress = (percent, text) => send('progress', { percent, text });
const pushLog = (line) => {
  logBuf.push(line);
  if (logBuf.length > 1500) logBuf.shift();
  send('log', line);
};

function handle(ch, fn) {
  ipcMain.handle(ch, async (_e, ...args) => {
    try {
      return { ok: true, data: await fn(...args) };
    } catch (e) {
      return { ok: false, error: e && e.message ? e.message : String(e) };
    }
  });
}

// ---------- окно ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1120,
    height: 700,
    minWidth: 980,
    minHeight: 620,
    frame: false,
    show: false,
    backgroundColor: '#0a0a0a',
    title: 'MisterCraft Launcher',
    icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('closed', () => { win = null; });
}

const lock = app.requestSingleInstanceLock();
if (!lock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(() => {
    P.ensure();
    createWindow();
  });
  app.on('window-all-closed', () => {
    if (gameProc) { /* игра продолжает работать независимо */ }
    app.quit();
  });
}

process.on('unhandledRejection', (e) => pushLog('[launcher] ' + (e && e.message ? e.message : e)));

// ---------- окно: кнопки ----------
handle('win:min', () => win && win.minimize());
handle('win:max', () => {
  if (!win) return;
  if (win.isMaximized()) win.unmaximize(); else win.maximize();
});
handle('win:close', () => win && win.close());

// ---------- информация ----------
handle('app:info', () => ({
  version: app.getVersion(),
  totalMb: Math.floor(os.totalmem() / 1048576),
  root: P.root,
}));

// ---------- версии ----------
handle('versions:manifest', async () => {
  const m = await V.getManifest();
  return {
    latest: m.latest,
    offline: m.offline,
    versions: m.versions.map((v) => ({ id: v.id, type: v.type, releaseTime: v.releaseTime })),
  };
});
handle('versions:installed', () => V.listInstalled());
handle('versions:delete', (id) => {
  if (state !== 'idle') throw new Error('Нельзя удалять версии во время установки или игры');
  V.deleteVersion(id);
});
handle('loaders:support', (mc) => {
  if (!V.validId(mc)) throw new Error('Недопустимая версия');
  return loaders.support(mc);
});

// ---------- настройки ----------
handle('settings:get', () => settings.getPublic());
handle('settings:set', (patch) => settings.update(patch || {}));

// ---------- аккаунты ----------
handle('accounts:list', () => settings.listAccounts());
handle('accounts:addOffline', (name) => {
  settings.saveAccount(auth.offlineAccount(String(name || '').trim()));
  return settings.listAccounts();
});
handle('accounts:select', (id) => { settings.setActive(id); return settings.listAccounts(); });
handle('accounts:remove', (id) => { settings.removeAccount(id); return settings.listAccounts(); });

handle('auth:microsoft', async () => {
  if (authAbort) throw new Error('Вход уже выполняется');
  const clientId = settings.getPublic().msClientId;
  authAbort = new AbortController();
  try {
    const acc = await auth.deviceLogin(clientId, (c) => send('auth:code', c), authAbort.signal);
    settings.saveAccount(acc);
    return settings.listAccounts();
  } finally {
    authAbort = null;
  }
});
handle('auth:cancel', () => { if (authAbort) authAbort.abort(); });

// ---------- Java ----------
handle('java:list', () => javaMod.findJavas());
handle('java:browse', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Выберите java.exe',
    properties: ['openFile'],
    filters: [{ name: 'Java', extensions: ['exe'] }],
  });
  return r.canceled ? null : r.filePaths[0];
});

// ---------- папки и ссылки ----------
handle('folder:open', async () => {
  P.ensure();
  const err = await shell.openPath(P.root);
  if (err) throw new Error(err);
});
handle('link:open', (url) => {
  if (typeof url !== 'string' || !/^https:\/\//.test(url)) throw new Error('Недопустимая ссылка');
  return shell.openExternal(url);
});

// ---------- игра ----------
handle('game:state', () => state);
handle('game:log', () => logBuf);
handle('game:stop', () => {
  if (gameProc) { userStopped = true; gameProc.kill(); }
});

handle('game:play', async ({ mc, loader }) => {
  if (state !== 'idle') throw new Error('Лаунчер уже занят');
  if (!V.validId(mc)) throw new Error('Не выбрана версия Minecraft');
  if (!['vanilla', 'fabric', 'forge'].includes(loader)) loader = 'vanilla';

  setState('installing');
  try {
    const s = settings.getPublic();
    const stored = settings.getAccount();
    if (!stored) throw new Error('Сначала добавьте аккаунт (кнопка «Аккаунт»)');

    progress(null, 'Подготовка…');
    await installer.installVanilla(mc, progress);

    const baseRes = V.loadResolved(mc);
    const need = javaMod.requiredMajor(baseRes);
    const javaPath = await javaMod.ensureJava(need, s.javaPath, progress);

    let id = mc;
    if (loader === 'fabric') id = await loaders.ensureFabric(mc, progress);
    else if (loader === 'forge') id = await loaders.ensureForge(mc, javaPath, progress);

    progress(null, 'Проверка аккаунта…');
    const acc = await auth.ensureFresh(stored, s.msClientId);
    settings.saveAccount(acc, false);

    progress(null, 'Запуск игры…');
    const cmd = launch.build({ id, account: acc, ramMb: s.ramMb, javaPath });

    logBuf.length = 0;
    pushLog(`[launcher] Версия: ${id}`);
    pushLog(`[launcher] Java: ${javaPath}`);
    userStopped = false;
    const child = spawn(cmd.javaPath, cmd.args, { cwd: cmd.cwd, windowsHide: true });
    gameProc = child;

    const onData = (d) => String(d).split(/\r?\n/).forEach((l) => l && pushLog(l));
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (e) => {
      pushLog('[launcher] Ошибка запуска: ' + e.message);
      send('toast', { type: 'error', text: 'Не удалось запустить Java: ' + e.message, log: true });
      gameProc = null;
      setState('idle');
    });
    child.on('close', (code) => {
      gameProc = null;
      pushLog(`[launcher] Игра завершилась с кодом ${code}`);
      if (win && !win.isDestroyed()) {
        if (win.isMinimized()) win.restore();
      }
      if (code !== 0 && !userStopped) {
        send('toast', { type: 'error', text: `Игра завершилась с ошибкой (код ${code})`, log: true });
      }
      progress(0, '');
      setState('idle');
    });

    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    progress(100, 'Игра запущена');
    setState('running');
    if (s.hideOnLaunch && win) win.minimize();
  } catch (e) {
    if (state !== 'running') {
      progress(0, '');
      setState('idle');
    }
    throw e;
  }
});
