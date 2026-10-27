import {normalizeKey, schedule, buildQueue, getStats, localDateKey} from './core.js';
import {openDB, all, get, putMeta, saveReview, exportBackup, importBackup} from './db.js';
import {PrivateSync} from './private-sync.js';

const $ = id => document.getElementById(id);
let words = [], progress = [], activity = [], settings = {dailyLimit:15, lang:'en-US'};
let current = null, flipped = false, saving = false, syncing = false, offlineReady = false, installPrompt;
let toastTimer, lastSync = 0;
let updatePending = false;
let shellReady=false,uploading=false,imageZoom=1;
const privateSync=new PrivateSync({onStatus:message=>{
  const states={syncing:'正在同步截图与复习进度…',queued:'截图已保存在待同步队列',disconnected:'私密连接已断开',ready:'私密词卡已更新',error:'暂时无法同步，已保留本设备的截图和进度','partial-error':'部分截图仍需重试',processing:'正在整理截图'};
  const value=typeof message==='string'?message:(message?.message||states[message?.state]||'正在同步私密词库…');
  $('private-status').textContent=value;
}});
const channel = 'BroadcastChannel' in window ? new BroadcastChannel('vocab:'+new URL('./',import.meta.url).pathname) : null;

function toast(message) {
  $('toast').textContent = message; $('toast').hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 5500);
}
function errorMessage(error) {return error?.message || '操作失败，请重试';}
function networkStatus() {$('network').textContent = navigator.onLine ? (offlineReady ? '离线已就绪' : '在线') : (offlineReady ? '离线复习中' : '当前离线');}
function displayImage(path){return privateSync.enabled?privateSync.imageURL(path):safeImage(path);}
function showImage(url){
  if(!url)return;
  imageZoom=1;$('full-image').src=url;updateZoom();
  $('image-viewer').showModal();$('viewer-scroll').scrollTo(0,0);
}
function updateZoom(){
  $('full-image').style.width=`${Math.round(imageZoom*100)}%`;
  $('zoom-level').textContent=`${Math.round(imageZoom*100)}%`;
  $('zoom-out').disabled=imageZoom<=1;$('zoom-in').disabled=imageZoom>=3;
}
function enableEnlargement(img){
  img.classList.add('enlargeable');img.tabIndex=0;img.setAttribute('role','button');
  img.setAttribute('aria-label','放大查看完整截图');
  img.onclick=event=>{event.stopPropagation();showImage(img.src);};
  img.onkeydown=event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();showImage(img.src);}};
}
function offlineStatus(){offlineReady=shellReady&&(!privateSync.enabled||words.every(w=>!w.image||privateSync.imageURL(w.image)));networkStatus();$('offline-detail').textContent=offlineReady?'离线已就绪：页面、当前词库与截图都已保存在此设备。':'页面缓存与截图仍在准备，联网完成同步后再离线使用。';}
function captureStatus(){
  $('capture-hint').textContent=privateSync.enabled?(privateSync.authenticated?'相册选图后直接同步；电脑新增图也会自动加入。':'已保存私密词库，输入同步凭据可获取新图。'):'先在设置中连接私密词库，再从手机相册添加截图。';
  $('disconnect-private').hidden=!privateSync.enabled;
  $('copy-private').hidden=!privateSync.authenticated;
}
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
  const currentIds=new Set(words.map(word=>normalizeKey(word.word)));
  const activeProgress=privateSync.enabled?progress.filter(row=>currentIds.has(row.id)):progress;
  const activeActivity=privateSync.enabled?activity.filter(row=>currentIds.has(row.wordId)):activity;
  const stats = getStats(words,activeProgress,activeActivity);
  $('stat-today').textContent=stats.todayStudied; $('stat-due').textContent=stats.due;
  $('stat-today-caption').textContent=privateSync.enabled?'张不同截图词卡':'个不同单词';
  $('stat-streak').replaceChildren(document.createTextNode(String(stats.streak)), Object.assign(document.createElement('span'),{textContent:' 天'}));
  const queue = buildQueue(words,activeProgress,settings.dailyLimit);
  $('queue-count').textContent=queue.length; $('library-count').textContent=words.length;
  $('daily-budget').textContent=`今日新${privateSync.enabled?'卡':'词'} ${stats.newToday} / ${settings.dailyLimit}`;
  $('date-label').textContent=new Date().toLocaleDateString('zh-CN',{month:'long',day:'numeric',weekday:'long'})+' / DAILY PRACTICE';
  const retained=keepCard && current && queue.find(w=>normalizeKey(w.word)===normalizeKey(current.word));
  const contentChanged=retained && JSON.stringify(retained)!==JSON.stringify(current);
  const imageChanged=retained && displayImage(retained.image)!==($('word-image').getAttribute('src')||null);
  const wasFlipped=flipped;
  if (!retained || contentChanged || imageChanged) {
    current=retained || queue[0] || null; flipped=false;
    const imageCard=current?.cardType==='image';
    $('word-card').classList.toggle('image-mode',imageCard);
    $('word-card').classList.remove('card-enter'); void $('word-card').offsetWidth; $('word-card').classList.add('card-enter');
    $('answer').hidden=true; $('ratings').hidden=true; $('flip').hidden=!current;
    $('speak').hidden=!current||imageCard; $('empty-detail').hidden=!!current;
    $('image-front').hidden=!imageCard;
    $('card-label').textContent=current?'TAKE A MOMENT. RECALL IT.':'A LITTLE EVERY DAY.';
    if (current) {
      $('word').textContent=imageCard?`截图词卡 ${String(words.indexOf(current)+1).padStart(2,'0')}`:current.word;
      $('card-kind').textContent=progress.some(p=>p.id===normalizeKey(current.word))?'↻ 到期复习':imageCard?'✧ 新截图词卡':'✧ 新词初见';
      $('phonetic').textContent=current.phonetic; $('meaning').textContent=current.meaning; $('example').textContent=current.example;
      $('phonetic').hidden=!current.phonetic;$('example').parentElement.hidden=!current.example;
      if(imageCard)$('meaning').textContent=current.meaning||'回忆截图中的单词、含义和用法，再给自己评分。';
      const img=displayImage(current.image); $('image-details').hidden=!img; $('image-details').open=imageCard;
      if (img) $('word-image').src=img; else $('word-image').removeAttribute('src');
      if(imageCard&&img)$('front-image').src=img;else $('front-image').removeAttribute('src');
      $('flip').replaceChildren(document.createTextNode(imageCard?'回忆好了，展开完整截图':'想一想，再查看释义'),Object.assign(document.createElement('span'),{textContent:'↗'}));
      for (const grade of ['forget','fuzzy','remember']) $('interval-'+grade).textContent=intervalText(grade);
      $('study-note').textContent=imageCard?'看图回忆；图片可放大。按实际记忆情况评分，系统会安排下次复习。':'先主动回忆，再翻开卡片。诚实的评分，比多学几个更有用。';
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
function flip() {if (!current || saving) return; flipped=true; $('answer').hidden=false; $('image-front').hidden=true;$('flip').hidden=true; $('ratings').hidden=false;}
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
    if(privateSync.authenticated&&navigator.onLine)privateSync.syncProgress().catch(()=>{});
  } catch(error) {toast('进度未保存：'+errorMessage(error));}
  finally {saving=false; document.querySelectorAll('[data-grade]').forEach(b=>b.disabled=false);if(updatePending)location.reload();}
}
function renderLibrary() {
  const query=normalizeKey($('search').value), list=$('word-list'); list.replaceChildren();
  const selected=words.filter((w,index)=>normalizeKey((w.cardType==='image'?`截图词卡 ${String(index+1).padStart(2,'0')}`:w.word)+' '+w.meaning).includes(query));
  if (!selected.length) {const p=document.createElement('p');p.className='empty-search';p.textContent='还没有找到这个词。';list.append(p);return;}
  for (const word of selected) {
    const row=document.createElement('details'); row.className='word-row';
    const summary=document.createElement('summary'), title=document.createElement('strong'), status=document.createElement('span');
    title.textContent=word.cardType==='image'?`截图词卡 ${String(words.indexOf(word)+1).padStart(2,'0')}`:word.word;
    const state=progress.find(p=>p.id===normalizeKey(word.word)); status.textContent=state?(state.dueAt<=Date.now()?'待复习':'已安排复习'):'未学习';
    summary.append(title,status);row.append(summary);
    const phonetic=document.createElement('p'), meaning=document.createElement('p'), example=document.createElement('p'), audio=document.createElement('button');
    phonetic.textContent=word.phonetic;meaning.textContent=word.meaning;example.textContent=word.example;example.className='library-example';audio.textContent='听发音';audio.onclick=()=>speak(word.word);audio.hidden=word.cardType==='image';row.append(phonetic,meaning,example,audio);
    const url=displayImage(word.image);if(url){const img=document.createElement('img');img.src=url;img.alt='单词截图来源';img.loading='lazy';enableEnlargement(img);row.append(img);}
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
    if(privateSync.enabled){
      if(!privateSync.authenticated){$('sync-label').textContent=`我的私密截图 · ${words.length} 张`;$('sync-detail').textContent='当前使用此设备已缓存的截图；在设置中连接后获取新图。';if(manual)toast('请在设置中填写私有词库同步凭据');return;}
      const before=new Set(words.map(w=>normalizeKey(w.word))),result=await privateSync.sync();
      words=result.words||words;await reloadState();lastSync=Date.now();
      const added=words.filter(w=>!before.has(normalizeKey(w.word))).length;
      $('sync-label').textContent=`我的私密截图 · ${words.length} 张`;
      $('sync-detail').textContent=`已同步 · ${new Date(lastSync).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit'})} · 截图与进度仅存入私有词库`;
      $('private-status').textContent=result.pending?`还有 ${result.pending} 张待上传，会自动重试。`:'连接正常，截图和复习进度已同步。';
      render({keepCard:true});offlineStatus();captureStatus();
      if(manual)toast(added?`加入 ${added} 张新截图`:'已同步至最新词库');return;
    }
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
    if(event.data?.type==='OFFLINE_READY'){shellReady=true;offlineStatus();}
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
enableEnlargement($('front-image'));enableEnlargement($('word-image'));
$('close-image').onclick=()=>$('image-viewer').close();
$('image-viewer').addEventListener('close',()=>{$('full-image').removeAttribute('src');});
$('zoom-in').onclick=()=>{imageZoom=Math.min(3,imageZoom+.5);updateZoom();};
$('zoom-out').onclick=()=>{imageZoom=Math.max(1,imageZoom-.5);updateZoom();};
$('word-card').onclick=event=>{if(event.target===$('word-card') || event.target===$('word'))flip();};
$('speak').onclick=()=>speak();
for(const button of document.querySelectorAll('[data-grade]'))button.onclick=()=>grade(button.dataset.grade);
$('tab-study').onclick=()=>tab('study');$('tab-library').onclick=()=>tab('library');$('search').oninput=renderLibrary;
$('sync').onclick=()=>sync(true);
$('open-settings').onclick=()=>{$('daily-limit').value=settings.dailyLimit;$('voice-language').value=settings.lang;$('private-repo').value=privateSync.config?.repo||'';$('private-token').value='';$('remember-private').checked=!!privateSync.config?.remember;$('settings').showModal();};
$('close-settings').onclick=()=>$('settings').close();
$('copy-private').onclick=async()=>{
  $('copy-private').disabled=true;
  try{await privateSync.copyCredential();toast('已复制同步凭据。仅粘贴到自己的设备，请勿发到聊天。');}
  catch(error){toast(errorMessage(error));}
  finally{$('copy-private').disabled=false;}
};
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
$('connect-private').onclick=async()=>{
  $('connect-private').disabled=true;
  try{
    const repo=$('private-repo').value.trim(),token=$('private-token').value.trim();
    if(!token)throw new Error('请填写仅限该私有词库的 GitHub 同步凭据');
    if($('image-viewer').open)$('image-viewer').close();
    await privateSync.configure(repo,token,$('remember-private').checked);$('private-token').value='';
    words=(await get('meta','privateWords'))?.value||[];current=null;render();captureStatus();await sync(true);
  }catch(error){toast(errorMessage(error));$('private-status').textContent=errorMessage(error);}
  finally{$('connect-private').disabled=false;}
};
$('disconnect-private').onclick=async()=>{try{if($('image-viewer').open)$('image-viewer').close();await privateSync.disconnect();words=[];current=null;captureStatus();await sync();toast('私密连接已断开，本设备复习进度保留');}catch(error){toast(errorMessage(error));}};
$('upload-images').onchange=async event=>{
  const files=Array.from(event.target.files||[]);if(!files.length||uploading)return;
  if(!privateSync.enabled||!privateSync.authenticated){toast('请先在设置连接私密词库');$('open-settings').click();event.target.value='';return;}
  uploading=true;$('upload-label').setAttribute('aria-disabled','true');
  try{await privateSync.queueFiles(files);toast(`已添加 ${files.length} 张截图到待同步队列`);await sync(true);}
  catch(error){toast(errorMessage(error));}
  finally{uploading=false;event.target.value='';$('upload-label').setAttribute('aria-disabled','false');}
};
window.addEventListener('online',()=>{networkStatus();sync();});window.addEventListener('offline',networkStatus);
channel && (channel.onmessage=async()=>{await reloadState();render({keepCard:true});});
document.addEventListener('visibilitychange',async()=>{if(document.visibilityState==='visible'){await reloadState();render({keepCard:true});if(privateSync.enabled||Date.now()-lastSync>60000)sync();}});
setInterval(()=>{if(!saving && !$('study-panel').hidden)render({keepCard:true});},30000);
setInterval(()=>{if(privateSync.authenticated&&!saving&&navigator.onLine&&document.visibilityState==='visible')sync();},15000);

try {
  await openDB();await reloadState();await privateSync.init();words=privateSync.enabled?((await get('meta','privateWords'))?.value||[]):validateWords((await get('meta','words'))?.value||[]);render();captureStatus();
  await sync();serviceWorker();
}catch(error){$('word').textContent='暂时无法保存进度';$('empty-detail').hidden=false;$('empty-detail').textContent='请用普通浏览模式打开，并允许此网站使用存储。'+errorMessage(error);$('flip').hidden=true;$('speak').hidden=true;toast('存储不可用，学习暂未启动');}
