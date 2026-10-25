import {normalizeKey, schedule, buildQueue, getStats, localDateKey} from './core.js';
import {openDB, all, get, putMeta, saveReview, exportBackup, importBackup} from './db.js';

const $ = id => document.getElementById(id);
let words = [], progress = [], activity = [], settings = {dailyLimit:15, lang:'en-US'};
let current = null, flipped = false, saving = false, syncing = false, offlineReady = false, installPrompt;
let toastTimer, lastSync = 0;
let updatePending = false;
const channel = 'BroadcastChannel' in window ? new BroadcastChannel('vocab:'+new URL('./',import.meta.url).pathname) : null;

function toast(message) {
  $('toast').textContent = message; $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 5500);
}
function errorMessage(error) {return error?.message || '操作失败，请重试';}
function networkStatus() {$('network').textContent = navigator.onLine ? (offlineReady ? '离线已就绪' : '在线') : (offlineReady ? '离线复习中' : '当前离线');}
function safeImage(path) {
  if (typeof path !== 'string' || !path.startsWith('images/') || path.includes('..') || path.includes('\\')) return null;
  const url = new URL(path, import.meta.url), base = new URL('./images/',import.meta.url);
  return url.href.startsWith(base.href) ? url.href : null;
}
function validateWords(data) {
  if (!Array.isArray(data)) throw new Error('词库格式无效，保留上次的词库');
  const seen = new Set();
  return data.map(row => {
    if (!row || typeof row !== 'object') throw new Error('词库含有无效记录');
    for (const key of ['word','phonetic','meaning','example','image','addedAt']) if (typeof row[key] !== 'string') throw new Error('词库缺少 '+key);
    const id = normalizeKey(row.word);
    if (!id || id.length>300 || seen.has(id) || !Number.isFinite(Date.parse(row.addedAt)) || (row.image && !safeImage(row.image))) throw new Error('词库存在重复单词、无效日期或图片路径');
    seen.add(id);
    return {...row};
  });
}
async function reloadState() {
  [progress, activity] = await Promise.all([all('progress'),all('activity')]);
  const saved = await get('meta','settings');
  settings = {...settings, ...saved?.value};
}
function intervalText(grade) {
  const next = schedule(progress.find(p => p.id===normalizeKey(current.word)) || {id:normalizeKey(current.word)}, grade);
  return grade==='forget' ? '10 分钟后' : `${next.interval} 天后`;
}
function render({keepCard=false}={}) {
  const stats = getStats(words,progress,activity);
  $('stat-today').textContent=stats.todayStudied; $('stat-due').textContent=stats.due;
  $('stat-streak').replaceChildren(document.createTextNode(String(stats.streak)), Object.assign(document.createElement('span'),{textContent:' 天'}));
  const queue = buildQueue(words,progress,settings.dailyLimit);
  $('queue-count').textContent=queue.length; $('library-count').textContent=words.length;
  $('daily-budget').textContent=`今日新词 ${stats.newToday} / ${settings.dailyLimit}`;
  $('date-label').textContent=new Date().toLocaleDateString('zh-CN',{month:'long',day:'numeric',weekday:'long'})+' / DAILY PRACTICE';
  const retained=keepCard && current && queue.find(w=>normalizeKey(w.word)===normalizeKey(current.word));
  const contentChanged=retained && JSON.stringify(retained)!==JSON.stringify(current);
  const wasFlipped=flipped;
  if (!retained || contentChanged) {
    current=retained || queue[0] || null; flipped=false;
    $('word-card').classList.remove('card-enter'); void $('word-card').offsetWidth; $('word-card').classList.add('card-enter');
    $('answer').hidden=true; $('ratings').hidden=true; $('flip').hidden=!current;
    $('speak').hidden=!current; $('empty-detail').hidden=!!current;
    $('card-label').textContent=current?'TAKE A MOMENT. RECALL IT.':'A LITTLE EVERY DAY.';
    if (current) {
      $('word').textContent=current.word;
      $('card-kind').textContent=progress.some(p=>p.id===normalizeKey(current.word))?'↻ 到期复习':'✧ 新词初见';
      $('phonetic').textContent=current.phonetic; $('meaning').textContent=current.meaning; $('example').textContent=current.example;
      const img=safeImage(current.image); $('image-details').hidden=!img; $('image-details').open=false;
      if (img) $('word-image').src=img; else $('word-image').removeAttribute('src');
      for (const grade of ['forget','fuzzy','remember']) $('interval-'+grade).textContent=intervalText(grade);
      $('study-note').textContent='先主动回忆，再翻开卡片。诚实的评分，比多学几个更有用。';
      if(retained && wasFlipped)flip();
    } else {
      $('word').textContent=words.length?'今天，也有进步。':'词库还在路上';
      $('card-kind').textContent=words.length?'✓ 暂时没有到期任务':'等待词库';
      const future = progress.filter(p=>words.some(w=>normalizeKey(w.word)===p.id) && p.dueAt>Date.now()).sort((a,b)=>a.dueAt-b.dueAt)[0];
      $('empty-detail').textContent=words.length?`当前可学任务已完成。${future?'下次复习：'+new Date(future.dueAt).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})+'。':''}去词库看看，或明天再见。`:'联网后点击“更新词库”，载入你的单词。';
      $('study-note').textContent='遗忘后重新想起来，也是记忆的一部分。';
    }
  }
  networkStatus();
  if (!$('library-panel').hidden) renderLibrary();
}
function flip() {if (!current || saving) return; flipped=true; $('answer').hidden=false; $('flip').hidden=true; $('ratings').hidden=false;}
function speak(text=current?.word) {
  if (!text) return;
  if (!('speechSynthesis' in window)) {toast('此浏览器暂不支持朗读');return;}
  speechSynthesis.cancel();
  const utterance=new SpeechSynthesisUtterance(text); utterance.lang=settings.lang; utterance.rate=.85;
  const voices=speechSynthesis.getVoices(); utterance.voice=voices.find(v=>v.lang===settings.lang && v.localService)||voices.find(v=>v.lang===settings.lang)||null;
  utterance.onerror=()=>toast('发音暂不可用，请检查设备英语语音包或联网重试'); speechSynthesis.speak(utterance);
}
async function grade(value) {
  if (!flipped || !current || saving) return;
  saving=true; document.querySelectorAll('[data-grade]').forEach(b=>b.disabled=true);
  try {
    const id=normalizeKey(current.word), now=Date.now();
    await saveReview(schedule(progress.find(p=>p.id===id)||{id},value,now),now);
    await reloadState(); render(); channel?.postMessage('progress');
  } catch(error) {toast('进度未保存：'+errorMessage(error));}
  finally {saving=false; document.querySelectorAll('[data-grade]').forEach(b=>b.disabled=false);if(updatePending)location.reload();}
}
function renderLibrary() {
  const query=normalizeKey($('search').value), list=$('word-list'); list.replaceChildren();
  const selected=words.filter(w=>normalizeKey(w.word+' '+w.meaning).includes(query));
  if (!selected.length) {const p=document.createElement('p');p.className='empty-search';p.textContent='还没有找到这个词。';list.append(p);return;}
  for (const word of selected) {
    const row=document.createElement('details'); row.className='word-row';
    const summary=document.createElement('summary'), title=document.createElement('strong'), status=document.createElement('span');
    title.textContent=word.word;
    const state=progress.find(p=>p.id===normalizeKey(word.word)); status.textContent=state?(state.dueAt<=Date.now()?'待复习':'已安排复习'):'未学习';
    summary.append(title,status);row.append(summary);
    const phonetic=document.createElement('p'), meaning=document.createElement('p'), example=document.createElement('p'), audio=document.createElement('button');
    phonetic.textContent=word.phonetic;meaning.textContent=word.meaning;example.textContent=word.example;example.className='library-example';audio.textContent='听发音';audio.onclick=()=>speak(word.word);row.append(phonetic,meaning,example,audio);
    const url=safeImage(word.image);if(url){const img=document.createElement('img');img.src=url;img.alt=word.word+' 的截图来源';img.loading='lazy';row.append(img);}
    list.append(row);
  }
}
function tab(name) {
  $('study-panel').hidden=name!=='study';$('library-panel').hidden=name!=='library';
  $('tab-study').setAttribute('aria-selected',name==='study');$('tab-library').setAttribute('aria-selected',name==='library');
  if(name==='library') renderLibrary(); else render({keepCard:true});
}
async function sync(manual=false) {
  if(syncing)return;syncing=true;$('sync').disabled=true;
  try {
    const response=await fetch(new URL('./data/words.json',import.meta.url),{cache:'no-store',signal:AbortSignal.timeout(12000)});
    if(!response.ok)throw new Error('服务器暂不可用');
    const next=validateWords(await response.json()), before=new Set(words.map(w=>normalizeKey(w.word))), added=next.filter(w=>!before.has(normalizeKey(w.word))).length;
    await putMeta('words',next); words=next;
    const cached=response.headers.get('X-Vocab-Cache')==='offline';
    if(!cached){lastSync=Date.now();await putMeta('lastSync',lastSync);}
    const isDemo=words.length>0 && words.every(w=>w.image.startsWith('images/demo-'));
    $('sync-label').textContent=isDemo?'示例词库 · 先试着学几个':`我的截图词库 · ${words.length} 个单词`;
    $('sync-detail').textContent=cached?'当前使用离线词库，联网后自动检查更新。':`已检查更新 · ${new Date(lastSync).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})} · 进度保存在此设备`;
    render({keepCard:true});
    if(manual)toast(cached?'已载入离线词库；联网后可获取新词':added?`词库已更新，加入 ${added} 个新词`:'已是最新词库，原有进度已保留');
  }catch(error){$('sync-detail').textContent=words.length?'暂时无法更新，继续使用已保存词库。':'词库加载失败，请联网后重试。';if(manual)toast('更新未完成：'+errorMessage(error));}
  finally{syncing=false;$('sync').disabled=false;networkStatus();}
}
async function serviceWorker() {
  if(!('serviceWorker' in navigator)){$('offline-detail').textContent='此浏览器不支持离线缓存，请用 Safari 或 Chrome 正式浏览器。';return;}
  navigator.serviceWorker.addEventListener('message',event=>{
    if(event.data?.type==='OFFLINE_READY'){offlineReady=true;$('offline-detail').textContent='离线已就绪：页面、词库和全部词库图片已缓存。';networkStatus();}
    if(event.data?.type==='OFFLINE_PARTIAL'){offlineReady=false;networkStatus();$('offline-detail').textContent='部分图片尚未缓存，请联网后再点“更新词库”。';}
  });
  try {
    const controlled=!!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange',()=>{if(controlled){updatePending=true;if(!saving)location.reload();}});
    const registration=await navigator.serviceWorker.register('./sw.js',{scope:'./',updateViaCache:'none'});
    await navigator.serviceWorker.ready;
    (navigator.serviceWorker.controller||registration.active)?.postMessage({type:'PREPARE_OFFLINE'});
    registration.update().catch(()=>{});
  }catch(error){$('offline-detail').textContent='离线准备未完成：'+errorMessage(error);}
}
$('flip').onclick=flip;
$('word-card').onclick=event=>{if(event.target===$('word-card') || event.target===$('word'))flip();};
$('speak').onclick=()=>speak();
for(const button of document.querySelectorAll('[data-grade]'))button.onclick=()=>grade(button.dataset.grade);
$('tab-study').onclick=()=>tab('study');$('tab-library').onclick=()=>tab('library');$('search').oninput=renderLibrary;
$('sync').onclick=()=>sync(true);
$('open-settings').onclick=()=>{$('daily-limit').value=settings.dailyLimit;$('voice-language').value=settings.lang;$('settings').showModal();};
$('close-settings').onclick=()=>$('settings').close();
$('save-settings').onclick=async()=>{
  const dailyLimit=Number($('daily-limit').value);
  if($('daily-limit').value===''||!Number.isInteger(dailyLimit)||dailyLimit<0||dailyLimit>200){toast('请输入 0 到 200 的整数；0 表示只复习旧词');return;}
  try{settings={dailyLimit,lang:$('voice-language').value};await putMeta('settings',settings);render({keepCard:true});channel?.postMessage('progress');$('settings').close();toast('设置已保存');}catch(error){toast(errorMessage(error));}
};
$('export').onclick=async()=>{try{
  const payload=await exportBackup(), blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}), url=URL.createObjectURL(blob), anchor=document.createElement('a');
  anchor.href=url;anchor.download=`词间-学习进度-${localDateKey()}.json`;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),20000);toast('备份已生成，请保存到文件或云盘');
}catch(error){toast(errorMessage(error));}};
$('import').onchange=async event=>{
  const file=event.target.files[0];if(!file)return;
  try{if(file.size>25*1024*1024)throw new Error('备份超过 25MB');await importBackup(JSON.parse(await file.text()));await reloadState();render();channel?.postMessage('progress');toast('备份已合并，较新的复习进度已保留');}catch(error){toast('导入失败：'+errorMessage(error));}finally{event.target.value='';}
};
window.addEventListener('beforeinstallprompt',event=>{event.preventDefault();installPrompt=event;$('install').hidden=false;});
$('install').onclick=async()=>{if(installPrompt){await installPrompt.prompt();installPrompt=null;$('install').hidden=true;}};
window.addEventListener('online',()=>{networkStatus();sync();});window.addEventListener('offline',networkStatus);
channel && (channel.onmessage=async()=>{await reloadState();render({keepCard:true});});
document.addEventListener('visibilitychange',async()=>{if(document.visibilityState==='visible'){await reloadState();render({keepCard:true});if(Date.now()-lastSync>60000)sync();}});
setInterval(()=>{if(!saving && !$('study-panel').hidden)render({keepCard:true});},30000);

try {
  await openDB();await reloadState();words=validateWords((await get('meta','words'))?.value||[]);render();
  await sync();serviceWorker();
}catch(error){$('word').textContent='暂时无法保存进度';$('empty-detail').hidden=false;$('empty-detail').textContent='请用普通浏览模式打开，并允许此网站使用存储。'+errorMessage(error);$('flip').hidden=true;$('speak').hidden=true;toast('存储不可用，学习暂未启动');}
