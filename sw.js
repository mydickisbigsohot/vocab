const BASE = new URL('./',self.location.href);
const PREFIX = 'vocab-'+BASE.pathname+'-';
const SHELL = PREFIX+'shell-__BUILD__';
const CONTENT = PREFIX+'content-v1';
const SHELL_FILES = ['./','./index.html','./styles.css','./app.js','./core.js','./db.js','./manifest.webmanifest','./icons/icon.svg','./icons/icon-192.png','./icons/icon-512.png','./icons/maskable-512.png','./icons/apple-touch-icon.png'].map(p=>new URL(p,BASE).href);
const WORDS_URL = new URL('./data/words.json',BASE).href;
async function announce(type) {for(const client of await self.clients.matchAll({type:'window',includeUncontrolled:true})){const url=new URL(client.url);if(url.origin===BASE.origin&&url.pathname.startsWith(BASE.pathname))client.postMessage({type});}}
function imageURLs(words) {
  if(!Array.isArray(words))throw new Error('Invalid words');
  return [...new Set(words.filter(w=>w.image).map(w=>{
    if(typeof w.image!=='string'||!w.image.startsWith('images/')||w.image.includes('..')||w.image.includes('\\'))throw new Error('Invalid image');
    const url=new URL(w.image,BASE);if(!url.href.startsWith(new URL('./images/',BASE).href))throw new Error('Invalid image');return url.href;
  }))];
}
async function warm(response) {
  const cache=await caches.open(CONTENT), urls=imageURLs(await response.clone().json());
  await cache.put(WORDS_URL,response.clone());
  let failed=false;
  for(let i=0;i<urls.length;i+=6)await Promise.all(urls.slice(i,i+6).map(async url=>{
    if(await cache.match(url))return;
    try{const image=await fetch(url,{signal:AbortSignal.timeout(12000)});if(!image.ok)throw new Error('image');await cache.put(url,image);}catch{failed=true;}
  }));
  await announce(failed?'OFFLINE_PARTIAL':'OFFLINE_READY');
}
async function prepare() {
  try{const response=await fetch(WORDS_URL,{cache:'no-store',signal:AbortSignal.timeout(10000)});if(!response.ok)throw new Error('words');await warm(response);}
  catch{const cache=await caches.open(CONTENT), saved=await cache.match(WORDS_URL);if(saved){const urls=imageURLs(await saved.clone().json());const found=await Promise.all(urls.map(u=>cache.match(u)));await announce(found.every(Boolean)?'OFFLINE_READY':'OFFLINE_PARTIAL');}else await announce('OFFLINE_PARTIAL');}
}
self.addEventListener('install',event=>event.waitUntil((async()=>{const cache=await caches.open(SHELL);await cache.addAll(SHELL_FILES);await self.skipWaiting();})()));
self.addEventListener('activate',event=>event.waitUntil((async()=>{for(const name of await caches.keys())if(name.startsWith(PREFIX+'shell-')&&name!==SHELL)await caches.delete(name);await self.clients.claim();await prepare();})()));
self.addEventListener('message',event=>{if(event.data?.type==='PREPARE_OFFLINE')event.waitUntil(prepare());});
self.addEventListener('fetch',event=>{
  const request=event.request,url=new URL(request.url);
  if(request.method!=='GET'||url.origin!==BASE.origin||!url.pathname.startsWith(BASE.pathname))return;
  if(url.href===WORDS_URL){
    let finish;const completion=new Promise(resolve=>finish=resolve);event.waitUntil(completion);
    event.respondWith((async()=>{
      try{const response=await fetch(request,{cache:'no-store',signal:AbortSignal.timeout(8000)});if(!response.ok)throw new Error('words');const copy=response.clone();warm(copy).catch(()=>announce('OFFLINE_PARTIAL')).finally(finish);return response;}
      catch{finish();const cache=await caches.open(CONTENT),saved=await cache.match(WORDS_URL);if(!saved)return new Response('Offline',{status:503});const headers=new Headers(saved.headers);headers.set('X-Vocab-Cache','offline');return new Response(saved.body,{status:200,headers});}
    })());return;
  }
  if(url.pathname.startsWith(new URL('./images/',BASE).pathname)){
    event.respondWith((async()=>{const cache=await caches.open(CONTENT),saved=await cache.match(request);if(saved)return saved;const response=await fetch(request);if(response.ok)await cache.put(request,response.clone());return response;})());return;
  }
  if(request.mode==='navigate'){
    event.respondWith((async()=>{const shell=await caches.open(SHELL),cached=await shell.match(new URL('./index.html',BASE).href);return cached||fetch(request);})());return;
  }
  event.respondWith((async()=>{const cached=await(await caches.open(SHELL)).match(request);return cached||fetch(request);})());
});
