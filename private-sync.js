import * as defaultStorage from './db.js';
import {validateBackup} from './core.js';

const API='https://api.github.com';
const IDENTITY={name:'Vocabulary Builder',email:'builder@users.noreply.github.com'};
const HASH=/^[a-f0-9]{64}$/;
const REPO=/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9_.-]{1,100}$/;
const FILE=/^(?:data\/(?:words|status|progress)\.json|(?:images|inbox)\/[a-f0-9]{64}\.webp)$/;
const encoder=new TextEncoder(),decoder=new TextDecoder('utf-8',{fatal:true});

export class PrivateSyncError extends Error {
  constructor(code,message){super(message);this.name='PrivateSyncError';this.code=code;}
}
const fail=(code,message)=>{throw new PrivateSyncError(code,message);};
const iso=()=>new Date().toISOString();
function base64(bytes){let text='';for(let i=0;i<bytes.length;i+=16384)text+=String.fromCharCode(...bytes.subarray(i,i+16384));return btoa(text);}
function unbase64(value){try{return Uint8Array.from(atob(value.replace(/\s/g,'')),c=>c.charCodeAt(0));}catch{fail('INVALID_REMOTE','私密词库的数据格式无效');}}
function parseJSON(bytes){try{return JSON.parse(decoder.decode(bytes));}catch{fail('INVALID_REMOTE','私密词库的数据格式无效');}}
function repoName(value){const repo=String(value||'').trim();if(!REPO.test(repo)||repo.split('/')[1]==='.'||repo.split('/')[1]==='..')fail('INVALID_REPO','请填写 GitHub用户名/私有仓库名');return repo;}

export function validatePrivateWords(value){
  if(!Array.isArray(value)||value.length>100000)fail('INVALID_WORDS','私密词库格式无效');
  const seen=new Set();
  return value.map(row=>{
    if(!row||typeof row!=='object'||!HASH.test(row.sourceHash||'')||row.cardType!=='image'||
       row.word!=='截图 '+row.sourceHash||row.image!=='images/'+row.sourceHash+'.webp'||
       !['phonetic','meaning','example'].every(key=>row[key]==='')||
       typeof row.addedAt!=='string'||!Number.isFinite(Date.parse(row.addedAt))||seen.has(row.sourceHash))fail('INVALID_WORDS','私密词库包含无效截图卡片');
    seen.add(row.sourceHash);
    return {word:row.word,phonetic:'',meaning:'',example:'',image:row.image,addedAt:row.addedAt,cardType:'image',sourceHash:row.sourceHash};
  });
}
function cloudBackup(value){const valid=validateBackup(value);return {...valid,meta:[],progress:valid.progress.sort((a,b)=>a.id.localeCompare(b.id)),activity:valid.activity.sort((a,b)=>a.id.localeCompare(b.id))};}
function comparable(value){return JSON.stringify({progress:value.progress,activity:value.activity,meta:[]});}
export function mergeProgress(local,remote){
  const left=cloudBackup(local),right=cloudBackup(remote),pick=(rows,time)=>{
    const map=new Map();for(const row of rows){const old=map.get(row.id);if(!old||row[time]>old[time]||(row[time]===old[time]&&JSON.stringify(row)>JSON.stringify(old)))map.set(row.id,row);}
    return [...map.values()].sort((a,b)=>a.id.localeCompare(b.id));
  };
  return {app:'screenshot-vocab',version:1,exportedAt:iso(),meta:[],progress:pick([...left.progress,...right.progress],'lastReviewedAt'),activity:pick([...left.activity,...right.activity],'reviewedAt')};
}
function emptyBackup(){return {app:'screenshot-vocab',version:1,exportedAt:iso(),progress:[],activity:[],meta:[]};}
function scopedBackup(value,ids){
  const valid=cloudBackup(value);
  return {...valid,progress:valid.progress.filter(row=>ids.has(row.id)),activity:valid.activity.filter(row=>ids.has(row.wordId))};
}
function statusValue(value){
  if(!value||value.version!==1||!['idle','processing','ready','partial-error','config-required'].includes(value.state))return null;
  const output={version:1,state:value.state};
  for(const name of ['pending','processed','failed'])output[name]=Number.isSafeInteger(value[name])&&value[name]>=0?value[name]:0;
  output.updatedAt=typeof value.updatedAt==='string'&&Number.isFinite(Date.parse(value.updatedAt))?value.updatedAt:null;
  output.errorCode=typeof value.errorCode==='string'&&/^[A-Z_]{1,64}$/.test(value.errorCode)?value.errorCode:null;
  return output;
}

async function compressScreenshot(file){
  if(typeof createImageBitmap!=='function'||typeof document==='undefined')fail('UNSUPPORTED_IMAGE','当前浏览器不能处理截图，请使用新版 Safari 或 Chrome');
  let bitmap;
  try{
    bitmap=await createImageBitmap(file,{imageOrientation:'from-image'});
    const width=Math.min(800,bitmap.width),height=Math.max(1,Math.round(bitmap.height*width/bitmap.width));
    if(!bitmap.width||!bitmap.height||width*height>30000000)fail('IMAGE_TOO_LARGE','截图过长，请先裁剪');
    const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
    const context=canvas.getContext('2d');if(!context)fail('UNSUPPORTED_IMAGE','当前浏览器不能处理截图');
    context.fillStyle='#fff';context.fillRect(0,0,width,height);context.drawImage(bitmap,0,0,width,height);
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/webp',.86));
    if(!blob||blob.type!=='image/webp'||blob.size>5*1024*1024)fail('IMAGE_TOO_LARGE','截图无法压缩，请裁剪后重试');
    return blob;
  }catch(error){if(error instanceof PrivateSyncError)throw error;fail('INVALID_IMAGE','有一张图片无法读取，请换一张截图重试');}
  finally{bitmap?.close();}
}

/** Credentials only go to api.github.com. Private image bytes stay out of CacheStorage. */
export class PrivateSync {
  #token='';#storage;#fetch;#compress;#urls=new Map();#syncing;#progressSyncing;#generation=0;#configuring=false;
  constructor({onStatus=()=>{},onWords=()=>{},fetcher=globalThis.fetch?.bind(globalThis),storage=defaultStorage,compressor=compressScreenshot}={}){
    this.config=null;this.onStatus=onStatus;this.onWords=onWords;this.#storage=storage;this.#fetch=fetcher;this.#compress=compressor;
  }
  get enabled(){return !!this.config?.repo;}
  get authenticated(){return this.enabled&&!!this.#token;}
  async copyCredential(clipboard=globalThis.navigator?.clipboard){
    if(!this.authenticated)fail('AUTH_REQUIRED','此设备没有保存同步凭据，需要重新生成并连接');
    if(!clipboard||typeof clipboard.writeText!=='function')fail('CLIPBOARD_UNAVAILABLE','请在 Chrome 或 Safari 的正式网页中复制同步凭据');
    try{await clipboard.writeText(this.#token);}catch{fail('CLIPBOARD_UNAVAILABLE','浏览器未允许复制，请在正式浏览器中点击按钮重试');}
  }
  #notify(value){this.onStatus(value);}
  #assertGeneration(generation){if(generation!==this.#generation)fail('CONNECTION_CHANGED','私密连接已改变，原请求已停止');}
  async #rememberMeta(key,value,generation){
    this.#assertGeneration(generation);await this.#storage.putMeta(key,value);
    if(generation!==this.#generation){await this.#storage.removeRecord('meta',key);this.#assertGeneration(generation);}
  }
  async init(){
    const saved=(await this.#storage.get('meta','privateConfig'))?.value;
    if(!saved)return null;
    try{this.config={repo:repoName(saved.repo),remember:saved.remember===true};}catch{return null;}
    this.#token=this.config.remember&&typeof saved.token==='string'?saved.token:'';
    const words=validatePrivateWords((await this.#storage.get('meta','privateWords'))?.value||[]);
    for(const row of await this.#storage.all('privateImages'))if(/^images\/[a-f0-9]{64}\.webp$/.test(row.id)&&row.blob instanceof Blob)this.#cacheURL(row.id,row.blob);
    return {words,status:(await this.#storage.get('meta','privateStatus'))?.value||null,pending:(await this.#queue()).length};
  }
  async configure(repo,token,remember=false){
    if(this.#syncing||this.#progressSyncing||this.#configuring)fail('SYNC_BUSY','正在同步，请稍后修改连接');
    this.#configuring=true;
    const generation=this.#generation;
    try{
    repo=repoName(repo);token=String(token||'').trim();
    if(!token||token.length>1000||/[\s\r\n]/.test(token))fail('AUTH_REQUIRED','请填写此私有词库专用的 GitHub 同步凭据');
    const queued=await this.#storage.all('uploadQueue');
    this.#assertGeneration(generation);
    if(queued.some(row=>row.repo!==repo))fail('QUEUED_OTHER_REPO','还有其他私密词库的截图待上传，请先连接原词库完成同步');
    const old=this.config,oldToken=this.#token;
    this.config={repo,remember:!!remember};this.#token=token;
    try{await this.#requirePrivate();}catch(error){if(generation===this.#generation){this.config=old;this.#token=oldToken;}throw error;}
    this.#assertGeneration(generation);
    if(old?.repo&&old.repo!==repo)await this.#clearImages();
    if(old?.repo!==repo){await this.#rememberMeta('privateWords',[],generation);await this.#rememberMeta('privateStatus',null,generation);}
    this.#assertGeneration(generation);
    this.#generation+=1;
    await this.#rememberMeta('privateConfig',{repo,remember:!!remember,token:remember?token:''},this.#generation);
    return this.config;
    }finally{this.#configuring=false;}
  }
  async disconnect(){
    this.#generation+=1;this.#token='';this.config=null;
    await this.#storage.removeRecord('meta','privateConfig');
    await this.#storage.removeRecord('meta','privateWords');
    await this.#storage.removeRecord('meta','privateStatus');
    await this.#clearImages();
    this.#notify({state:'disconnected'});
  }
  async #clearImages(){for(const url of this.#urls.values())URL.revokeObjectURL(url);this.#urls.clear();for(const row of await this.#storage.all('privateImages'))await this.#storage.removeRecord('privateImages',row.id);}
  #cacheURL(path,blob){const old=this.#urls.get(path);if(old)URL.revokeObjectURL(old);this.#urls.set(path,URL.createObjectURL(blob));}
  imageURL(path){return this.#urls.get(path)||null;}
  #prefix(){if(!this.authenticated)fail('AUTH_REQUIRED','请先连接私密词库');return '/repos/'+this.config.repo.split('/').map(encodeURIComponent).join('/');}
  async #api(path,{method='GET',body,missing=false}={}){
    const prefix=this.#prefix();
    const generation=this.#generation;
    if(!path.startsWith(prefix+'/')&&path!==prefix)fail('INVALID_REQUEST','同步请求无效');
    let response;
    try{response=await this.#fetch(API+path,{method,headers:{Authorization:'Bearer '+this.#token,Accept:'application/vnd.github+json','Content-Type':'application/json','X-GitHub-Api-Version':'2022-11-28'},body:body===undefined?undefined:JSON.stringify(body),cache:'no-store',credentials:'omit',redirect:'error',signal:AbortSignal.timeout(20000)});}
    catch{fail('NETWORK_UNAVAILABLE','暂时无法连接 GitHub，截图和进度仍保存在此设备');}
    this.#assertGeneration(generation);
    if(missing&&response.status===404)return null;
    if(response.status===409||response.status===422)fail('CONFLICT','私密词库正在更新，请稍后重试');
    if(response.status===401||response.status===403)fail('AUTH_REQUIRED','同步凭据无效、权限不足或请求受限，请检查私有词库的访问权限');
    if(!response.ok)fail('REQUEST_FAILED','私密词库暂时不可用，请稍后重试');
    let result;
    try{result=response.status===204?{}:await response.json();}catch{fail('INVALID_REMOTE','GitHub 返回了无效数据');}
    this.#assertGeneration(generation);return result;
  }
  async #requirePrivate(){const metadata=await this.#api(this.#prefix());if(metadata?.private!==true)fail('PUBLIC_REPO_BLOCKED','已停止同步：只能连接私有仓库，公开仓库不会接收截图或进度');if(metadata.archived||metadata.disabled)fail('REPO_UNAVAILABLE','私有仓库当前不可用');}
  async #read(path){
    if(!FILE.test(path))fail('INVALID_PATH','私密文件路径无效');
    const info=await this.#api(this.#prefix()+'/contents/'+path+'?ref=main',{missing:true});
    if(!info)return null;
    if(typeof info.sha!=='string'||!/^[a-f0-9]{40,64}$/.test(info.sha))fail('INVALID_REMOTE','私密文件版本无效');
    let content=info;
    if(info.encoding==='none')content=await this.#api(this.#prefix()+'/git/blobs/'+info.sha);
    if(content.encoding!=='base64'||typeof content.content!=='string')fail('INVALID_REMOTE','私密文件内容无效');
    return {sha:info.sha,bytes:unbase64(content.content)};
  }
  async #write(path,bytes,sha,message){
    if(!FILE.test(path))fail('INVALID_PATH','私密文件路径无效');
    await this.#requirePrivate();
    return this.#api(this.#prefix()+'/contents/'+path,{method:'PUT',body:{message,content:base64(bytes),branch:'main',...(sha?{sha}:{}),author:IDENTITY,committer:IDENTITY}});
  }
  async #queue(){return(await this.#storage.all('uploadQueue')).filter(row=>row.repo===this.config?.repo);}
  async queueFiles(files){
    if(this.#configuring)fail('SYNC_BUSY','正在连接私密词库，请稍后添加截图');
    if(!this.enabled)fail('AUTH_REQUIRED','请先连接自己的私密词库，再添加截图');
    const repo=this.config.repo;let queued=0;
    for(const file of Array.from(files)){
      if(!file||!['image/png','image/jpeg','image/webp','image/bmp'].includes(file.type)||file.size>25*1024*1024||!file.size)fail('INVALID_IMAGE','请添加不超过 25MB 的 PNG、JPG、WebP 或 BMP 截图');
      const bytes=await file.arrayBuffer(),digest=await crypto.subtle.digest('SHA-256',bytes),id=Array.from(new Uint8Array(digest),x=>x.toString(16).padStart(2,'0')).join('');
      const existing=await this.#storage.get('uploadQueue',id);
      if(existing){if(existing.repo!==repo)fail('QUEUED_OTHER_REPO','相同截图仍在另一个词库的上传队列');continue;}
      const known=(await this.#storage.get('meta','privateWords'))?.value||[];
      if(known.some(row=>row.sourceHash===id))continue;
      const blobWebp=await this.#compress(file);
      if(!blobWebp||blobWebp.type!=='image/webp'||blobWebp.size>5*1024*1024)fail('INVALID_IMAGE','截图压缩失败，请裁剪后重试');
      if(this.config?.repo!==repo)fail('CONNECTION_CHANGED','私密连接已改变，截图未加入新词库');
      await this.#storage.putRecord('uploadQueue',{id,repo,blobWebp,createdAt:iso(),retries:0});queued+=1;
    }
    const pending=(await this.#queue()).length;this.#notify({state:'queued',queued,pending});return {queued,pending};
  }
  async #upload(){
    const uploaded=[];
    for(const row of await this.#queue()){
      if(!HASH.test(row.id)||!(row.blobWebp instanceof Blob)||row.blobWebp.type!=='image/webp')continue;
      try{
        const already=await this.#read('images/'+row.id+'.webp');
        if(!already){
          for(let attempt=0;attempt<3;attempt++){
            try{await this.#write('images/'+row.id+'.webp',new Uint8Array(await row.blobWebp.arrayBuffer()),null,'Add screenshot to private vocabulary');break;}
            catch(error){if(error.code!=='CONFLICT'||attempt===2)throw error;if(await this.#read('images/'+row.id+'.webp'))break;}
          }
        }
        uploaded.push(row);
      }catch(error){await this.#storage.putRecord('uploadQueue',{...row,retries:(row.retries||0)+1});throw error;}
    }
    if(!uploaded.length)return;
    for(let attempt=0;attempt<3;attempt++){
      const index=await this.#read('data/words.json'),words=validatePrivateWords(index?parseJSON(index.bytes):[]),known=new Set(words.map(row=>row.sourceHash));
      const additions=uploaded.filter(row=>!known.has(row.id)).map(row=>({word:'截图 '+row.id,phonetic:'',meaning:'',example:'',image:'images/'+row.id+'.webp',addedAt:row.createdAt,cardType:'image',sourceHash:row.id}));
      if(additions.length){
        try{await this.#write('data/words.json',encoder.encode(JSON.stringify(validatePrivateWords([...words,...additions]))),index?.sha,'Index private screenshot cards');}
        catch(error){if(error.code==='CONFLICT'&&attempt<2)continue;throw error;}
      }
      for(const row of uploaded)await this.#storage.removeRecord('uploadQueue',row.id);
      return;
    }
  }
  async syncProgress(currentWords){
    if(this.#configuring)fail('SYNC_BUSY','正在连接私密词库，请稍后同步');
    if(this.#progressSyncing)return this.#progressSyncing;
    this.#progressSyncing=(async()=>{
      const generation=this.#generation;await this.#requirePrivate();
      const wordsFile=currentWords===undefined?await this.#read('data/words.json'):null;
      const words=validatePrivateWords(currentWords===undefined?(wordsFile?parseJSON(wordsFile.bytes):[]):currentWords);
      const ids=new Set(words.map(word=>word.word));
      for(let attempt=0;attempt<3;attempt++){
        const remoteFile=await this.#read('data/progress.json'),remoteSource=remoteFile?cloudBackup(parseJSON(remoteFile.bytes)):emptyBackup(),remote=scopedBackup(remoteSource,ids);
        const local=scopedBackup(await this.#storage.exportBackup(),ids),merged=mergeProgress(local,remote);
        this.#assertGeneration(generation);
        if(comparable(merged)!==comparable(remoteSource)){
          try{await this.#write('data/progress.json',encoder.encode(JSON.stringify(merged)),remoteFile?.sha,'Sync private learning progress');}
          catch(error){if(error.code==='CONFLICT'&&attempt<2)continue;throw error;}
        }
        this.#assertGeneration(generation);await this.#storage.importBackup(merged);return merged;
      }
    })();
    try{return await this.#progressSyncing;}finally{this.#progressSyncing=null;}
  }
  async sync(){
    if(this.#configuring)fail('SYNC_BUSY','正在连接私密词库，请稍后同步');
    if(this.#syncing)return this.#syncing;
    const generation=this.#generation;
    this.#syncing=(async()=>{
      await this.#requirePrivate();this.#notify({state:'syncing'});
      await this.#upload();
      const file=await this.#read('data/words.json');
      const words=validatePrivateWords(file?parseJSON(file.bytes):[]);
      let missingImages=0;
      for(const word of words){
        this.#assertGeneration(generation);
        if(this.#urls.has(word.image))continue;
        let cached=await this.#storage.get('privateImages',word.image);
        this.#assertGeneration(generation);
        if(!cached){const image=await this.#read(word.image);if(!image){missingImages+=1;continue;}cached={id:word.image,blob:new Blob([image.bytes],{type:'image/webp'})};this.#assertGeneration(generation);await this.#storage.putRecord('privateImages',cached);if(generation!==this.#generation){await this.#storage.removeRecord('privateImages',word.image);this.#assertGeneration(generation);}}
        this.#assertGeneration(generation);
        this.#cacheURL(word.image,cached.blob);
      }
      await this.syncProgress(words);
      const statusFile=await this.#read('data/status.json'),status=statusValue(statusFile?parseJSON(statusFile.bytes):null)||{version:1,state:'ready',pending:0,processed:words.length,failed:0,errorCode:null};
      if(generation!==this.#generation)fail('CONNECTION_CHANGED','私密连接已改变，请重新同步');
      await this.#rememberMeta('privateWords',words,generation);await this.#rememberMeta('privateStatus',status,generation);
      const pending=(await this.#queue()).length;this.onWords(words);this.#notify({...status,pendingUploads:pending,missingImages});
      return {words,status,pending,missingImages};
    })();
    try{return await this.#syncing;}catch(error){this.#notify({state:'error',code:error.code||'SYNC_FAILED'});throw error;}finally{this.#syncing=null;}
  }
}
