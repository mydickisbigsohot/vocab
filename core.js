// Pure learning rules, shared by the app and its regression tests.
export const DAY = 24 * 60 * 60 * 1000;
const MAX_DATE = 8640000000000000;

export function normalizeKey(word) {
  return String(word ?? '').normalize('NFC').trim().replace(/\s+/gu, ' ').toLocaleLowerCase('en-US');
}

export function databaseName(moduleURL) {
  // IndexedDB already isolates origins; include the app directory to isolate
  // several GitHub Pages repositories served under the same github.io origin.
  return `vocab-learning-v1:${encodeURIComponent(new URL('.', moduleURL).pathname)}`;
}

export function localDateKey(value = Date.now()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('日期无效');
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function timestamp(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= MAX_DATE;
}

/**
 * Three-button SM-2: forget=1, fuzzy=3, remember=5.
 * A forgotten item enters a 10-minute relearning step; successful reviews use
 * the standard 1 day, 6 days, then previous interval * previous ease sequence.
 */
export function schedule(previous, grade, now = Date.now()) {
  const qualities = { forget: 1, fuzzy: 3, remember: 5 };
  const quality = Object.hasOwn(qualities, grade) ? qualities[grade] : undefined;
  if (quality === undefined) throw new Error('评分无效');
  if (!timestamp(now)) throw new Error('复习时间无效');
  const id = normalizeKey(previous?.id);
  if (!id) throw new Error('单词标识不能为空');
  const oldEase = Number.isFinite(previous.ease) ? Math.max(1.3, previous.ease) : 2.5;
  const oldRepetitions = Number.isInteger(previous.repetitions) ? Math.max(0, previous.repetitions) : 0;
  const oldInterval = Number.isFinite(previous.interval) ? Math.max(0, previous.interval) : 0;
  const ease = Math.max(1.3, Math.round((oldEase + 0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02)) * 100) / 100);
  const repetitions = quality < 3 ? 0 : oldRepetitions + 1;
  const interval = quality < 3 ? 0 : oldRepetitions === 0 ? 1 : oldRepetitions === 1 ? 6 : Math.max(1, Math.round(oldInterval * oldEase));
  return {
    ...previous,
    id,
    repetitions,
    interval,
    ease,
    dueAt: now + (quality < 3 ? 10 * 60 * 1000 : interval * DAY),
    lastReviewedAt: now,
    firstStudiedAt: timestamp(previous.firstStudiedAt) ? previous.firstStudiedAt : now,
  };
}

/** Due reviews always precede new words, including when today's new limit is 0. */
export function buildQueue(words, progressArray = [], limit = 15, now = Date.now()) {
  const progress = new Map(progressArray.map(row => [normalizeKey(row.id), row]));
  const today = localDateKey(now);
  const introduced = progressArray.filter(row => timestamp(row.firstStudiedAt) && localDateKey(row.firstStudiedAt) === today).length;
  const allowance = Math.max(0, (Number.isFinite(Number(limit)) ? Math.max(0, Math.floor(Number(limit))) : 15) - introduced);
  const unique = new Map();
  for (const word of words) {
    const key = normalizeKey(word.word);
    if (key && !unique.has(key)) unique.set(key, word);
  }
  const due = [];
  const fresh = [];
  for (const [key, word] of unique) {
    const state = progress.get(key);
    if (!state) fresh.push(word);
    else if (state.dueAt <= now) due.push(word);
  }
  due.sort((a, b) => progress.get(normalizeKey(a.word)).dueAt - progress.get(normalizeKey(b.word)).dueAt || normalizeKey(a.word).localeCompare(normalizeKey(b.word), 'en'));
  fresh.sort((a, b) => (Date.parse(a.addedAt) || 0) - (Date.parse(b.addedAt) || 0) || normalizeKey(a.word).localeCompare(normalizeKey(b.word), 'en'));
  return [...due, ...fresh.slice(0, allowance)];
}

export function getStats(words, progressArray = [], activityArray = [], now = Date.now()) {
  const current = new Set(words.map(word => normalizeKey(word.word)));
  const today = localDateKey(now);
  const todayWords = new Set(activityArray.filter(row => row.day === today).map(row => row.wordId));
  const days = new Set(activityArray.map(row => row.day));
  const cursor = new Date(now);
  cursor.setHours(12, 0, 0, 0);
  if (!days.has(localDateKey(cursor))) cursor.setDate(cursor.getDate() - 1);
  let streak = 0;
  while (days.has(localDateKey(cursor))) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return {
    todayStudied: todayWords.size,
    due: progressArray.filter(row => current.has(normalizeKey(row.id)) && row.dueAt <= now).length,
    streak,
    total: current.size,
    learned: progressArray.filter(row => current.has(normalizeKey(row.id))).length,
    newToday: progressArray.filter(row => timestamp(row.firstStudiedAt) && localDateKey(row.firstStudiedAt) === today).length,
  };
}

function fail(message) { throw new Error(`备份文件无效：${message}`); }
function record(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function validId(id) { return typeof id === 'string' && id.length > 0 && id.length <= 300 && normalizeKey(id) === id; }
function validDay(day) {
  if (typeof day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const date = new Date(`${day}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === day;
}

/** Fully validates before an IndexedDB write can start. Returns isolated data. */
export function validateBackup(payload) {
  if (!record(payload) || payload.app !== 'screenshot-vocab' || payload.version !== 1) fail('版本或应用标识不匹配');
  for (const key of ['progress', 'activity', 'meta']) {
    if (!Array.isArray(payload[key]) || payload[key].length > 200000) fail(`${key} 不是有效数组`);
  }
  const progressIds = new Set();
  const progress = payload.progress.map(row => {
    if (!record(row) || !validId(row.id) || progressIds.has(row.id)) fail('单词标识重复或不规范');
    if (!Number.isInteger(row.repetitions) || row.repetitions < 0 || row.repetitions > 1000000) fail('复习次数无效');
    if (!Number.isFinite(row.interval) || row.interval < 0 || row.interval > 365000) fail('复习间隔无效');
    if (!Number.isFinite(row.ease) || row.ease < 1.3 || row.ease > 100) fail('记忆系数无效');
    if (![row.dueAt, row.lastReviewedAt, row.firstStudiedAt].every(timestamp) || row.firstStudiedAt > row.lastReviewedAt || row.dueAt < row.lastReviewedAt) fail('复习时间无效');
    progressIds.add(row.id);
    return { id: row.id, repetitions: row.repetitions, interval: row.interval, ease: row.ease, dueAt: row.dueAt, lastReviewedAt: row.lastReviewedAt, firstStudiedAt: row.firstStudiedAt };
  });
  const activityIds = new Set();
  const activity = payload.activity.map(row => {
    if (!record(row) || !validId(row.wordId) || !validDay(row.day) || row.id !== `${row.day}|${row.wordId}` || activityIds.has(row.id)) fail('学习记录无效');
    if (!timestamp(row.reviewedAt)) fail('学习记录时间无效');
    activityIds.add(row.id);
    return { id: row.id, day: row.day, wordId: row.wordId, reviewedAt: row.reviewedAt };
  });
  const metaIds = new Set();
  const meta = payload.meta.map(row => {
    if (!record(row) || typeof row.key !== 'string' || !row.key || row.key.length > 100 || metaIds.has(row.key) || !Object.hasOwn(row, 'value')) fail('设置无效');
    metaIds.add(row.key);
    // These are the app's user preferences; never import cached word lists or opaque values.
    if (row.key === 'settings') {
      if (!record(row.value) || !Number.isInteger(row.value.dailyLimit) || row.value.dailyLimit < 0 || row.value.dailyLimit > 200) fail('每日新词上限无效');
      const lang = row.value.lang ?? 'en-US';
      if (!['en-US', 'en-GB'].includes(lang)) fail('发音语言无效');
      return { key: row.key, value: { dailyLimit: row.value.dailyLimit, lang } };
    }
    // Unknown metadata is intentionally ignored during import, keeping the backup forward compatible.
    return null;
  }).filter(Boolean);
  return { app: 'screenshot-vocab', version: 1, exportedAt: payload.exportedAt, progress, activity, meta };
}
