import { databaseName, localDateKey, normalizeKey, validateBackup } from './core.js';

const DB_NAME = databaseName(import.meta.url);
let connection;

export function openDB() {
  if (connection) return connection;
  connection = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore('progress', { keyPath: 'id' });
      db.createObjectStore('meta', { keyPath: 'key' });
      db.createObjectStore('activity', { keyPath: 'id' });
    };
    request.onerror = () => { connection = undefined; reject(request.error); };
    request.onblocked = () => { connection = undefined; reject(new Error('请关闭此应用的其他旧标签页后重试')); };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); connection = undefined; };
      resolve(db);
    };
  });
  return connection;
}

function readRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function completed(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error || new Error('进度保存失败，请重试'));
    transaction.onerror = () => reject(transaction.error || new Error('进度保存失败，请检查存储空间'));
  });
}

export async function all(store) {
  const db = await openDB();
  return readRequest(db.transaction(store, 'readonly').objectStore(store).getAll());
}

export async function get(store, key) {
  const db = await openDB();
  return readRequest(db.transaction(store, 'readonly').objectStore(store).get(key));
}

export async function putMeta(key, value) {
  const db = await openDB();
  const tx = db.transaction('meta', 'readwrite');
  const done = completed(tx);
  tx.objectStore('meta').put({ key, value });
  await done;
}

export async function saveReview(progress, now = Date.now()) {
  const db = await openDB();
  const tx = db.transaction(['progress', 'activity'], 'readwrite');
  const done = completed(tx);
  const id = normalizeKey(progress.id);
  const day = localDateKey(now);
  tx.objectStore('progress').put({ ...progress, id });
  tx.objectStore('activity').put({ id: `${day}|${id}`, wordId: id, day, reviewedAt: now });
  await done;
}

export async function exportBackup() {
  const db = await openDB();
  const tx = db.transaction(['progress', 'meta', 'activity'], 'readonly');
  const done = completed(tx);
  const [progress, meta, activity] = await Promise.all(['progress', 'meta', 'activity'].map(store => readRequest(tx.objectStore(store).getAll())));
  await done;
  // Only user preferences belong in backups, not cached vocabulary or cache state.
  return { app: 'screenshot-vocab', version: 1, exportedAt: new Date().toISOString(), progress, meta: meta.filter(row => row.key === 'settings'), activity };
}

/** One atomic transaction; newest review wins, daily study history is a union. */
export async function importBackup(payload) {
  const backup = validateBackup(payload);
  const db = await openDB();
  const tx = db.transaction(['progress', 'meta', 'activity'], 'readwrite');
  const done = completed(tx);
  const progressStore = tx.objectStore('progress');
  const activityStore = tx.objectStore('activity');
  for (const row of backup.progress) {
    const request = progressStore.get(row.id);
    request.onsuccess = () => {
      const existing = request.result;
      if (!existing || row.lastReviewedAt > existing.lastReviewedAt) progressStore.put(row);
    };
  }
  for (const row of backup.activity) {
    const request = activityStore.get(row.id);
    request.onsuccess = () => {
      const existing = request.result;
      if (!existing || row.reviewedAt > existing.reviewedAt) activityStore.put(row);
    };
  }
  for (const row of backup.meta) tx.objectStore('meta').put(row);
  await done;
  return { progress: backup.progress.length, activity: backup.activity.length };
}
