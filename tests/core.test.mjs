import test from 'node:test';
import assert from 'node:assert/strict';
import { DAY, databaseName, normalizeKey, localDateKey, schedule, buildQueue, getStats, validateBackup } from '../core.js';

const now = new Date(2026, 9, 25, 12).getTime();
const word = (name, addedAt = '2026-10-20T00:00:00Z') => ({ word: name, addedAt });
const state = (id, when = now) => schedule({ id }, 'remember', when);
const backup = () => ({ app: 'screenshot-vocab', version: 1, progress: [state('hello')], activity: [], meta: [] });

test('keys ignore whitespace, English casing and Unicode composition', () => {
  assert.equal(normalizeKey('  Take\t  OFF '), 'take off');
  assert.equal(normalizeKey('CAFE\u0301'), normalizeKey('CAFÉ'));
});

test('database names isolate GitHub Pages repositories and survive code updates', () => {
  const url = 'https://learner.github.io/vocab/db.js';
  assert.equal(databaseName(url), 'vocab-learning-v1:%2Fvocab%2F');
  assert.equal(databaseName(`${url}?v=2`), databaseName(url));
  assert.equal(databaseName('https://learner.github.io/vocab/core.js'), databaseName(url));
  assert.notEqual(databaseName('https://learner.github.io/another/db.js'), databaseName(url));
  assert.notEqual(databaseName('https://learner.github.io/db.js'), databaseName(url));
});

test('SM-2 successful reviews use 1, 6 and ease-adjusted days', () => {
  const first = schedule({ id: 'word' }, 'remember', now);
  const second = schedule(first, 'remember', first.dueAt);
  const third = schedule(second, 'remember', second.dueAt);
  assert.equal(first.interval, 1);
  assert.equal(second.interval, 6);
  assert.equal(third.interval, Math.round(6 * 2.7));
  assert.equal(third.firstStudiedAt, now);
  assert.equal(third.repetitions, 3);
  assert.equal(first.dueAt, now + DAY);
});

test('forgotten words reappear after ten minutes and restart successful sequence', () => {
  const before = { ...state('word'), interval: 30, repetitions: 4 };
  const forgotten = schedule(before, 'forget', now);
  assert.equal(forgotten.dueAt, now + 600000);
  assert.equal(forgotten.repetitions, 0);
  assert.equal(schedule(forgotten, 'fuzzy', forgotten.dueAt).interval, 1);
  assert.equal(before.repetitions, 4);
});

test('fuzzy reduces ease but stays successful; ease never falls below 1.3', () => {
  const fuzzy = schedule({ id: 'word' }, 'fuzzy', now);
  assert.equal(fuzzy.interval, 1);
  assert.equal(fuzzy.ease, 2.36);
  assert.equal(fuzzy.repetitions, 1);
  let progress = fuzzy;
  for (let i = 0; i < 15; i++) progress = schedule(progress, 'forget', now);
  assert.equal(progress.ease, 1.3);
});

test('unknown ratings and invalid timestamps are rejected without modifying state', () => {
  const progress = { id: 'word' };
  assert.throws(() => schedule(progress, 'toString', now));
  assert.throws(() => schedule(progress, 'remember', NaN));
  assert.throws(() => schedule({ id: '  ' }, 'remember', now));
  assert.deepEqual(progress, { id: 'word' });
});

test('due words take priority and are never blocked by daily new quota', () => {
  const due = { ...state('review', now - 2 * DAY), dueAt: now - 1 };
  const today = state('today');
  assert.deepEqual(buildQueue([word('fresh'), word('review'), word('today')], [due, today], 1, now).map(row => row.word), ['review']);
  assert.deepEqual(buildQueue([word('review')], [due], 0, now).map(row => row.word), ['review']);
});

test('new vocabulary merges with existing progress without reintroducing learned words', () => {
  const progress = state('old');
  assert.deepEqual(buildQueue([word('Old'), word('new'), word('NEW')], [progress], 15, now).map(row => row.word), ['new']);
  assert.equal(progress.firstStudiedAt, now);
});

test('daily new allowance resets at local midnight', () => {
  const previousDay = new Date(2026, 9, 24, 23, 59).getTime();
  const today = new Date(2026, 9, 25, 0, 1).getTime();
  assert.equal(localDateKey(today), '2026-10-25');
  const progress = state('yesterday', previousDay);
  assert.equal(buildQueue([word('new')], [progress], 1, today).length, 1);
});

test('today counts unique words and streak bridges yesterday until today is learned', () => {
  const records = ['2026-10-23', '2026-10-24'].map(day => ({ id: `${day}|a`, day, wordId: 'a', reviewedAt: now }));
  assert.equal(getStats([word('a')], [], records, now).streak, 2);
  records.push({ id: '2026-10-25|a', day: '2026-10-25', wordId: 'a', reviewedAt: now });
  records.push({ id: '2026-10-25|a', day: '2026-10-25', wordId: 'a', reviewedAt: now });
  const stats = getStats([word('a')], [], records, now);
  assert.equal(stats.todayStudied, 1);
  assert.equal(stats.streak, 3);
});

test('backup rejects invalid dates, duplicate ids and malformed settings before writing', () => {
  assert.equal(validateBackup(backup()).progress.length, 1);
  const badDate = backup();
  badDate.progress[0].dueAt = 'tomorrow';
  assert.throws(() => validateBackup(badDate));
  const duplicate = backup();
  duplicate.progress.push(duplicate.progress[0]);
  assert.throws(() => validateBackup(duplicate));
  const badSetting = backup();
  badSetting.meta.push({ key: 'settings', value: { dailyLimit: -1 } });
  assert.throws(() => validateBackup(badSetting));
  const invalidHistory = backup();
  invalidHistory.activity.push({ id: '2026-02-30|hello', day: '2026-02-30', wordId: 'hello', reviewedAt: now });
  assert.throws(() => validateBackup(invalidHistory));
});

test('valid backup produces independent data and only imports recognized settings', () => {
  const source = backup();
  source.meta = [{ key: 'settings', value: { dailyLimit: 20, lang: 'en-GB' } }, { key: 'words', value: ['malicious cache'] }];
  const result = validateBackup(source);
  result.progress[0].interval = 20;
  assert.equal(source.progress[0].interval, 1);
  assert.deepEqual(result.meta, [{ key: 'settings', value: { dailyLimit: 20, lang: 'en-GB' } }]);
});
