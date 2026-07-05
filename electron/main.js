import { app, BrowserWindow, ipcMain } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { uIOhook } from 'uiohook-napi';
import { startServer } from '../server/index.js';
import {
  typeText,
  cancelTyping,
  pauseTyping,
  resetTypingState,
  setTypingConfig,
  abortForRearm,
  beginTypingSession,
  isTypingAborted,
  resumeIndexAfterContinue,
  getTypingEndIndex,
  SPEED_MAX,
} from './typer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 5174;

let mainWindow = null;
let armed = false;
let isTyping = false;
let hookStarted = false;

let session = null;
let progressFrozen = false;
let sessionCancelled = false;

function beginCancel() {
  sessionCancelled = true;
  cancelTyping();
  disarm();
}

function updateProgress(current, total) {
  if (progressFrozen || !session) return;
  session.nextIndex = current;
  sendProgress(current, total);
}

function freezeProgress(atIndex) {
  progressFrozen = true;
  if (!session) return 0;

  const clamped = Math.max(0, Math.min(Math.floor(atIndex), session.text.length));
  session.nextIndex = clamped;
  sendProgress(clamped, session.text.length);
  return clamped;
}

function sendStatus(status) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('autofill:status', status);
  }
}

function sendProgress(current, total) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    const percent = total > 0 ? Math.round((current / total) * 100) : 0;
    mainWindow.webContents.send('autofill:progress', { current, total, percent });
  }
}

function sendComplete() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('autofill:complete');
  }
}

function isClickInsideWindow(screenX, screenY) {
  if (!mainWindow || mainWindow.isDestroyed()) return false;

  const bounds = mainWindow.getBounds();
  return (
    screenX >= bounds.x
    && screenX <= bounds.x + bounds.width
    && screenY >= bounds.y
    && screenY <= bounds.y + bounds.height
  );
}

function clearSession() {
  session = null;
  armed = false;
  isTyping = false;
  progressFrozen = false;
  sessionCancelled = false;
}

function disarm() {
  armed = false;
}

function arm() {
  if (!session) return;
  armed = true;
  sendStatus('armed');
}

async function runTyping(fromIndex = 0) {
  if (!session || isTyping || sessionCancelled) return;

  disarm();
  isTyping = true;
  sendStatus('typing');

  const config = session;
  setTypingConfig({ speed: config.speed, errorRate: config.errorRate });

  const startIndex = session.resumeFromContinue
    ? (config.oneSentenceAtATime
        ? fromIndex
        : resumeIndexAfterContinue(fromIndex, config.speed))
    : fromIndex;
  session.resumeFromContinue = false;

  const generation = beginTypingSession();

  try {
    await new Promise((resolve) => setTimeout(resolve, 200));

    if (!session || isTypingAborted(generation)) {
      isTyping = false;
      return;
    }

    const endIndex = getTypingEndIndex(
      config.text,
      startIndex,
      config.oneSentenceAtATime,
    );

    const result = await typeText(config.text, {
      speed: config.speed,
      errorRate: config.errorRate,
      startIndex,
      endIndex,
      pressEnterOnComplete: config.pressEnterOnComplete,
      generation,
      onProgress: (current, total) => {
        updateProgress(current, total);
      },
    });

    isTyping = false;

    if (result.rearm) {
      resetTypingState();
      return;
    }

    if (result.cancelled) {
      if (sessionCancelled) {
        clearSession();
        resetTypingState();
        sendStatus('cancelled');
        sendProgress(0, 0);
      }
      return;
    }

    const hasMoreSentences = config.oneSentenceAtATime && endIndex < config.text.length;
    if (hasMoreSentences) {
      session.nextIndex = endIndex;
      progressFrozen = true;
      disarm();
      resetTypingState();
      sendStatus('paused');
      sendProgress(endIndex, config.text.length);
      return;
    }

    clearSession();
    resetTypingState();
    sendProgress(config.text.length, config.text.length);
    sendStatus('done');
  } catch (err) {
    isTyping = false;
    clearSession();
    resetTypingState();
    sendStatus(`error:${err.message || 'Typing failed'}`);
    sendProgress(0, 0);
  } finally {
    sendComplete();
  }
}

function onMouseDown(event) {
  if (!armed || event.button !== 1 || sessionCancelled) return;
  if (isClickInsideWindow(event.x, event.y)) return;

  runTyping(session?.nextIndex ?? 0);
}

function ensureHook() {
  if (hookStarted) return;

  uIOhook.on('mousedown', onMouseDown);
  uIOhook.start();
  hookStarted = true;
}

async function createWindow() {
  if (!app.isPackaged) {
    process.env.NODE_ENV = 'development';
  } else {
    process.env.NODE_ENV = 'production';
    process.env.AUTOFILL_BOT_ROOT = path.dirname(process.execPath);
  }

  const { url } = await startServer({ host: '127.0.0.1', port: PORT });

  mainWindow = new BrowserWindow({
    width: 620,
    height: 1014,
    minWidth: 480,
    minHeight: 960,
    autoHideMenuBar: true,
    title: 'AutoFill Bot',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadURL(url);

  mainWindow.on('closed', () => {
    mainWindow = null;
    clearSession();
  });

  ensureHook();
}

ipcMain.handle('autofill:start', async (_event, config) => {
  const text = typeof config?.text === 'string' ? config.text : '';
  if (!text.trim()) {
    return { ok: false, error: 'Enter text to type first.' };
  }

  clearSession();
  resetTypingState();

  progressFrozen = false;
  sessionCancelled = false;
  session = {
    text,
    speed: Math.min(SPEED_MAX, Math.max(0, Number(config.speed) || 50)),
    errorRate: Number(config.errorRate) || 0,
    pressEnterOnComplete: Boolean(config.pressEnterOnComplete),
    oneSentenceAtATime: Boolean(config.oneSentenceAtATime),
    nextIndex: 0,
  };

  arm();
  sendProgress(0, text.length);

  return { ok: true, status: 'armed' };
});

ipcMain.handle('autofill:pause', async () => {
  if (!session) {
    return { ok: false };
  }

  pauseTyping();

  const frozenIndex = freezeProgress(session.nextIndex ?? 0);

  if (armed) {
    disarm();
  }

  sendStatus('paused');

  return { ok: true, atIndex: frozenIndex };
});

async function waitForTypingIdle() {
  while (isTyping) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

ipcMain.handle('autofill:continue', async (_event, config) => {
  if (!session) {
    return { ok: false, error: 'No active session.' };
  }

  const text = typeof config?.text === 'string' ? config.text : session.text;
  if (!text.trim()) {
    return { ok: false, error: 'Enter text to type first.' };
  }

  session.text = text;
  session.speed = Math.min(SPEED_MAX, Math.max(0, Number(config?.speed) ?? session.speed));
  session.errorRate = Number(config?.errorRate) ?? session.errorRate;
  if (config?.pressEnterOnComplete !== undefined) {
    session.pressEnterOnComplete = Boolean(config.pressEnterOnComplete);
  }
  if (config?.oneSentenceAtATime !== undefined) {
    session.oneSentenceAtATime = Boolean(config.oneSentenceAtATime);
  }
  session.nextIndex = Math.min(session.nextIndex ?? 0, text.length);
  setTypingConfig({ speed: session.speed, errorRate: session.errorRate });

  if (isTyping) {
    abortForRearm();
    await waitForTypingIdle();
  }

  progressFrozen = false;
  resetTypingState();
  session.resumeFromContinue = true;
  arm();
  const progressIndex = session.oneSentenceAtATime
    ? (session.nextIndex ?? 0)
    : resumeIndexAfterContinue(session.nextIndex ?? 0, session.speed);
  sendProgress(progressIndex, session.text.length);
  return { ok: true, status: 'armed' };
});

ipcMain.on('autofill:cancelImmediate', () => {
  beginCancel();
});

ipcMain.handle('autofill:cancel', async () => {
  beginCancel();
  await waitForTypingIdle();
  clearSession();
  resetTypingState();
  sendStatus('cancelled');
  sendProgress(0, 0);
  sendComplete();
  return { ok: true };
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (hookStarted) {
    uIOhook.stop();
  }
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
