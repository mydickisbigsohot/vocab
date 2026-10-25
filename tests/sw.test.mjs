import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = (await readFile(new URL('../sw.js', import.meta.url), 'utf8')).replace('__BUILD__', 'test-build');
const origin = 'https://learner.github.io';
const base = `${origin}/vocab/`;
const wordsURL = `${base}data/words.json`;
const imageURL = `${base}images/one.webp`;
const sample = [{ word: 'hello', image: 'images/one.webp' }];
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });

function harness() {
  const listeners = new Map();
  const storage = new Map();
  const messages = [];
  const calls = [];
  let claimed = 0;
  let skipped = 0;
  let network = async input => input === wordsURL ? json(sample) : new Response(`asset:${input}`);
  const key = input => typeof input === 'string' ? input : input.url;
  const fetch = async input => { calls.push(key(input)); return network(key(input)); };
  class Cache {
    entries = new Map();
    async match(input) { return this.entries.get(key(input))?.clone(); }
    async put(input, response) { this.entries.set(key(input), response.clone()); }
    async addAll(inputs) {
      const loaded = await Promise.all(inputs.map(async input => {
        const response = await fetch(input);
        if (!response.ok) throw new Error('network failure');
        return [input, response];
      }));
      for (const [input, response] of loaded) await this.put(input, response);
    }
  }
  const caches = {
    async open(name) {
      if (!storage.has(name)) storage.set(name, new Cache());
      return storage.get(name);
    },
    async keys() { return [...storage.keys()]; },
    async delete(name) { return storage.delete(name); },
  };
  const self = {
    location: { href: `${base}sw.js` },
    addEventListener(type, callback) { listeners.set(type, callback); },
    async skipWaiting() { skipped += 1; },
    clients: {
      async matchAll() { return [{ url: base, postMessage: value => messages.push(value) }]; },
      async claim() { claimed += 1; },
    },
  };
  vm.runInNewContext(source, { self, caches, fetch, URL, Response, Headers, AbortSignal, console });
  async function dispatch(type, extra = {}) {
    let response;
    const pending = [];
    listeners.get(type)?.({
      ...extra,
      waitUntil(promise) { pending.push(promise); },
      respondWith(promise) { response = Promise.resolve(promise); },
    });
    const result = response ? await response : undefined;
    await Promise.all(pending);
    return result;
  }
  return {
    dispatch, caches, storage, messages, calls,
    network(fn) { network = fn; },
    lifecycle() { return { claimed, skipped }; },
    request(url, mode = 'cors', method = 'GET') { return dispatch('fetch', { request: { url, mode, method } }); },
  };
}

test('install precaches relative subpath shell and does not request site-root assets', async () => {
  const env = harness();
  await env.dispatch('install');
  const shell = await env.caches.open('vocab-/vocab/-shell-test-build');
  assert.ok(await shell.match(`${base}index.html`));
  assert.ok(await shell.match(`${base}core.js`));
  assert.ok(await shell.match(`${base}icons/icon-512.png`));
  assert.equal(await shell.match(`${origin}/index.html`), undefined);
  assert.ok(env.calls.every(url => url.startsWith(base)));
  assert.equal(env.lifecycle().skipped, 1);
});

test('activate only deletes this app old shells, retains content and other repositories', async () => {
  const env = harness();
  await env.caches.open('vocab-/vocab/-shell-old');
  await env.caches.open('vocab-/another/-shell-old');
  await env.caches.open('vocab-/vocab/-content-v1');
  await env.dispatch('install');
  await env.dispatch('activate');
  const keys = await env.caches.keys();
  assert.ok(!keys.includes('vocab-/vocab/-shell-old'));
  assert.ok(keys.includes('vocab-/another/-shell-old'));
  assert.ok(keys.includes('vocab-/vocab/-content-v1'));
  assert.equal(env.lifecycle().claimed, 1);
  assert.equal(env.messages.at(-1).type, 'OFFLINE_READY');
});

test('live word update caches data and every referenced image before announcing ready', async () => {
  const env = harness();
  const response = await env.request(wordsURL);
  assert.deepEqual(await response.json(), sample);
  const content = await env.caches.open('vocab-/vocab/-content-v1');
  assert.deepEqual(await (await content.match(wordsURL)).json(), sample);
  assert.ok(await content.match(imageURL));
  assert.equal(env.messages.at(-1).type, 'OFFLINE_READY');
  assert.equal(env.calls.filter(url => url === imageURL).length, 1);
});

test('offline words fall back to cached JSON and mark the response as offline', async () => {
  const env = harness();
  await env.request(wordsURL);
  env.network(async () => { throw new TypeError('offline'); });
  const response = await env.request(wordsURL);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('X-Vocab-Cache'), 'offline');
  assert.deepEqual(await response.json(), sample);
  assert.equal(response.headers.get('Content-Type'), 'application/json');
});

test('first visit offline returns a clear unavailable response rather than corrupt JSON', async () => {
  const env = harness();
  env.network(async () => { throw new TypeError('offline'); });
  const response = await env.request(wordsURL);
  assert.equal(response.status, 503);
});

test('failed image warming reports partial and the next preparation retries it', async () => {
  const env = harness();
  env.network(async url => url === wordsURL ? json(sample) : new Response('missing', { status: 404 }));
  await env.request(wordsURL);
  assert.equal(env.messages.at(-1).type, 'OFFLINE_PARTIAL');
  const content = await env.caches.open('vocab-/vocab/-content-v1');
  assert.equal(await content.match(imageURL), undefined);
  env.network(async url => url === wordsURL ? json(sample) : new Response('image'));
  await env.dispatch('message', { data: { type: 'PREPARE_OFFLINE' } });
  assert.ok(await content.match(imageURL));
  assert.equal(env.messages.at(-1).type, 'OFFLINE_READY');
});

test('cached screenshots and navigation remain available offline under the repository path', async () => {
  const env = harness();
  await env.dispatch('install');
  await env.request(wordsURL);
  env.network(async () => { throw new TypeError('offline'); });
  assert.equal(await (await env.request(imageURL)).text(), `asset:${imageURL}`);
  const page = await env.request(`${base}?from=homescreen`, 'navigate');
  assert.equal(await page.text(), `asset:${base}index.html`);
});

test('requests outside app scope, cross-origin requests and POST are not intercepted', async () => {
  const env = harness();
  assert.equal(await env.request(`${origin}/another/app.js`), undefined);
  assert.equal(await env.request('https://other.example/vocab/app.js'), undefined);
  assert.equal(await env.request(`${base}app.js`, 'cors', 'POST'), undefined);
  assert.equal(env.calls.length, 0);
});

test('invalid image paths cannot overwrite the last valid cached word list', async () => {
  const env = harness();
  await env.request(wordsURL);
  env.network(async () => json([{ word: 'bad', image: 'images/../private.png' }]));
  await env.request(wordsURL);
  const content = await env.caches.open('vocab-/vocab/-content-v1');
  assert.deepEqual(await (await content.match(wordsURL)).json(), sample);
  assert.equal(env.messages.at(-1).type, 'OFFLINE_PARTIAL');
  assert.ok(!env.calls.some(url => url.endsWith('private.png')));
});
