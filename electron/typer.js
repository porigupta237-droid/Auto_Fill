import { keyboard, Key, clipboard } from '@nut-tree-fork/nut-js';

const ADJACENT_KEYS = {
  a: ['q', 's', 'z', 'w'],
  b: ['v', 'g', 'h', 'n'],
  c: ['x', 'd', 'f', 'v'],
  d: ['s', 'e', 'r', 'f', 'c', 'x'],
  e: ['w', 's', 'd', 'r'],
  f: ['d', 'r', 't', 'g', 'v', 'c'],
  g: ['f', 't', 'y', 'h', 'b', 'v'],
  h: ['g', 'y', 'u', 'j', 'n', 'b'],
  i: ['u', 'j', 'k', 'o'],
  j: ['h', 'u', 'i', 'k', 'm', 'n'],
  k: ['j', 'i', 'o', 'l', 'm'],
  l: ['k', 'o', 'p'],
  m: ['n', 'j', 'k'],
  n: ['b', 'h', 'j', 'm'],
  o: ['i', 'k', 'l', 'p'],
  p: ['o', 'l'],
  q: ['w', 'a', 's'],
  r: ['e', 'd', 'f', 't'],
  s: ['a', 'w', 'e', 'd', 'x', 'z'],
  t: ['r', 'f', 'g', 'y'],
  u: ['y', 'h', 'j', 'i'],
  v: ['c', 'f', 'g', 'b'],
  w: ['q', 'a', 's', 'e'],
  x: ['z', 'a', 's', 'd', 'c'],
  y: ['t', 'g', 'h', 'u'],
  z: ['a', 's', 'x'],
  '0': ['9', '1'],
  '1': ['0', '2'],
  '2': ['1', '3'],
  '3': ['2', '4'],
  '4': ['3', '5'],
  '5': ['4', '6'],
  '6': ['5', '7'],
  '7': ['6', '8'],
  '8': ['7', '9'],
  '9': ['8', '0'],
};

export const SPEED_MAX = 500;

export function speedToContinueOffset(speed) {
  const s = Math.max(0, Math.min(SPEED_MAX, Number(speed) || 0));
  if (s <= 80) return Math.round((s / 80) * 2);
  if (s <= 100) return Math.round(2 + ((s - 80) / 20) * 2);
  if (s <= 300) return Math.round(4 + ((s - 100) / 200) * 2);
  if (s <= 500) return Math.round(6 + ((s - 300) / 200) * 3);
  return 9;
}

export function resumeIndexAfterContinue(committedIndex, speed) {
  return Math.max(0, committedIndex - speedToContinueOffset(speed));
}

let cancelled = false;
let paused = false;
let abortedForRearm = false;
let typingGeneration = 0;
let activeSpeed = 50;
let activeErrorRate = 0;

function isAborted(generation) {
  return cancelled || generation !== typingGeneration;
}

export function beginTypingSession() {
  cancelled = false;
  paused = false;
  abortedForRearm = false;
  typingGeneration += 1;
  return typingGeneration;
}

export function isTypingAborted(generation) {
  return isAborted(generation);
}

export function setTypingConfig({ speed, errorRate } = {}) {
  if (speed !== undefined) {
    activeSpeed = Math.max(0, Math.min(SPEED_MAX, speed));
  }
  if (errorRate !== undefined) {
    activeErrorRate = Math.max(0, Math.min(10, errorRate));
  }
}

export function pauseTyping() {
  paused = true;
}

export function resumeTyping() {
  paused = false;
}

export function cancelTyping() {
  cancelled = true;
  paused = false;
  abortedForRearm = false;
  typingGeneration += 1;
}

export function abortForRearm() {
  abortedForRearm = true;
  cancelled = true;
  paused = false;
  typingGeneration += 1;
}

export function resetTypingState() {
  cancelled = false;
  paused = false;
  abortedForRearm = false;
}

function delay(ms, generation) {
  const step = 25;
  let elapsed = 0;

  return new Promise((resolve) => {
    const tick = () => {
      if (isAborted(generation) || elapsed >= ms) {
        resolve();
        return;
      }

      if (paused) {
        setTimeout(tick, step);
        return;
      }

      const chunk = Math.min(step, ms - elapsed);
      setTimeout(() => {
        elapsed += chunk;
        tick();
      }, chunk);
    };

    tick();
  });
}

async function waitWhilePaused(generation) {
  while (paused && !isAborted(generation)) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function randomAdjacent(char) {
  const lower = char.toLowerCase();
  const neighbors = ADJACENT_KEYS[lower];
  if (!neighbors?.length) return char;

  const pick = neighbors[Math.floor(Math.random() * neighbors.length)];
  if (char !== lower) {
    return pick.toUpperCase();
  }
  return pick;
}

function speedToDelay(speed) {
  const clamped = Math.max(0, Math.min(SPEED_MAX, speed));
  if (clamped <= 100) {
    return 250 - (clamped / 100) * 245;
  }
  return 0;
}

function errorToProbability(errorRate) {
  const clamped = Math.max(0, Math.min(10, errorRate));
  return (clamped / 10) * 0.3;
}

const CLAUSE_DASH_PATTERN = /[\u2013\u2014\u2015]\s*/;

export function getTypingEndIndex(text, startIndex, oneSentenceAtATime) {
  if (!oneSentenceAtATime || startIndex >= text.length) {
    return text.length;
  }

  const slice = text.slice(startIndex);
  const punctMatch = slice.match(/[.!?]["')\]]*(?=\s|$)/);
  if (punctMatch) {
    return startIndex + punctMatch.index + punctMatch[0].length;
  }

  const dashMatch = slice.match(CLAUSE_DASH_PATTERN);
  if (dashMatch) {
    return startIndex + dashMatch.index + dashMatch[0].length;
  }

  const newlineIdx = slice.indexOf('\n');
  if (newlineIdx >= 0) {
    return startIndex + newlineIdx + 1;
  }

  return text.length;
}

function readCharAt(text, index) {
  const codePoint = text.codePointAt(index);
  if (codePoint === undefined) {
    return { char: text[index] ?? '', length: 1 };
  }
  return {
    char: String.fromCodePoint(codePoint),
    length: codePoint > 0xffff ? 2 : 1,
  };
}

function needsClipboardPaste(char) {
  const codePoint = char.codePointAt(0);
  return codePoint !== undefined && codePoint > 0x7f;
}

async function pasteChar(char, generation) {
  if (isAborted(generation)) return;

  let previous = '';
  try {
    previous = await clipboard.getContent();
  } catch {
    previous = '';
  }

  await clipboard.setContent(char);
  if (isAborted(generation)) return;

  await keyboard.pressKey(Key.LeftControl, Key.V);
  if (isAborted(generation)) return;

  await keyboard.releaseKey(Key.V, Key.LeftControl);
  if (isAborted(generation)) return;

  try {
    await clipboard.setContent(previous);
  } catch {
    // Ignore clipboard restore failures.
  }
}

async function typeNewline(generation) {
  if (isAborted(generation)) return;

  await keyboard.pressKey(Key.LeftShift);
  if (isAborted(generation)) return;

  await keyboard.pressKey(Key.Enter);
  if (isAborted(generation)) return;

  await keyboard.releaseKey(Key.Enter);
  if (isAborted(generation)) return;

  await keyboard.releaseKey(Key.LeftShift);
}

async function typeSubmit(generation) {
  if (isAborted(generation)) return;

  await keyboard.pressKey(Key.Enter);
  if (isAborted(generation)) return;

  await keyboard.releaseKey(Key.Enter);
}

async function typeChar(char, generation) {
  if (isAborted(generation)) return;

  if (char === '\n' || char === '\r') {
    await typeNewline(generation);
    return;
  }

  if (needsClipboardPaste(char)) {
    await pasteChar(char, generation);
    return;
  }

  await keyboard.type(char);
}

export async function typeText(
  text,
  {
    speed = 50,
    errorRate = 0,
    startIndex = 0,
    endIndex,
    pressEnterOnComplete = false,
    onProgress,
    generation,
  } = {},
) {
  const activeGeneration = generation ?? beginTypingSession();
  setTypingConfig({ speed, errorRate });

  keyboard.config.autoDelayMs = 0;
  const limit = endIndex ?? text.length;

  for (let i = startIndex; i < limit; ) {
    await waitWhilePaused(activeGeneration);
    if (isAborted(activeGeneration)) break;

    const baseDelay = speedToDelay(activeSpeed);
    const errorProb = errorToProbability(activeErrorRate);
    const { char, length: charLength } = readCharAt(text, i);
    const isTypable = char !== '\n' && char !== '\r';
    const shouldMistype = isTypable && /[a-zA-Z0-9]/.test(char) && Math.random() < errorProb;

    if (shouldMistype) {
      const wrong = randomAdjacent(char);
      await typeChar(wrong, activeGeneration);
      if (isAborted(activeGeneration)) break;

      await delay(baseDelay, activeGeneration);
      if (isAborted(activeGeneration)) break;

      await waitWhilePaused(activeGeneration);
      if (isAborted(activeGeneration)) break;

      await keyboard.pressKey(Key.Backspace);
      if (isAborted(activeGeneration)) break;

      await keyboard.releaseKey(Key.Backspace);
      if (isAborted(activeGeneration)) break;

      await delay(baseDelay * 0.4, activeGeneration);
      if (isAborted(activeGeneration)) break;
    }

    await typeChar(char, activeGeneration);
    if (isAborted(activeGeneration)) break;

    i += charLength;

    if (onProgress && !paused) {
      onProgress(i, text.length);
    }

    if (isAborted(activeGeneration)) break;

    const jitter = baseDelay * (0.7 + Math.random() * 0.6);
    await delay(jitter, activeGeneration);
  }

  if (!isAborted(activeGeneration) && pressEnterOnComplete) {
    await waitWhilePaused(activeGeneration);
    if (!isAborted(activeGeneration)) {
      await typeSubmit(activeGeneration);
    }
  }

  const wasRearm = abortedForRearm;
  const wasCancelled = !wasRearm && (cancelled || activeGeneration !== typingGeneration);

  return {
    cancelled: wasCancelled,
    rearm: wasRearm,
    paused: false,
  };
}
