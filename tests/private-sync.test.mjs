import test from 'node:test';
import assert from 'node:assert/strict';
import {PrivateSync,mergeProgress,validatePrivateWords} from '../private-sync.js';
import {schedule,validateBackup} from '../core.js';

const REPO='example-owner/private-words',PREFIX='/repos/'+REPO,TOKEN='github_pat_test_value_not_real';
const SHA='a'.repeat(64),OTHER='b'.repeat(64);
const jsonResponse=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
const card=hash=>({word:'截图 '+hash,phonetic:'',meaning:'',example:'',image:'images/'+hash+'.webp',addedAt:'2020-01-01T00:00:00Z',cardType:'image',sourceHash:hash});
const backup=()=>({app:'screenshot-vocab',version:1,progress:[],activity:[],meta:[]});

function storage(){
  const stores=Object.fromEntries(['meta','privateImages','uploadQueue'].map(key=>[key,new Map()]));let progress=backup();
  return {
    stores,
    async get(store,key){return structuredClone(stores[store].get(key));},
    async all(store){return structuredClone([...stores[store].values()]);},
    async putMeta(key,value){stores.meta.set(key,structuredClone({key,value}));},
    async putRecord(store,row){stores[store].set(row.id,structuredClone(row));},
    async removeRecord(store,key){stores[store].delete(key);},
    async exportBackup(){return structuredClone(progress);},
    async importBackup(value){progress=mergeProgress(progress,validateBackup(value));},
    setProgress(value){progress=structuredClone(value);},
  };
}
function api(){
  const files=new Map(),calls=[];let privateRepo=true,version=1,onPut;
  const put=(path,value)=>files.set(path,{sha:(version++).toString(16).padStart(40,'0'),content:typeof value==='string'?value:JSON.stringify(value)});
  const fetcher=async(url,options)=>{
    assert.equal(new URL(url).origin,'https://api.github.com');
    assert.equal(options.credentials,'omit');assert.equal(options.redirect,'error');
    assert.equal(options.headers.Authorization,'Bearer '+TOKEN);
    const pathname=new URL(url).pathname,method=options.method||'GET',body=options.body?JSON.parse(options.body):null;
    calls.push({url,method,body});
    if(pathname===PREFIX)return jsonResponse({private:privateRepo});
    const path=pathname.slice((PREFIX+'/contents/').length);
    if(!pathname.startsWith(PREFIX+'/contents/'))return jsonResponse({},404);
    if(method==='GET'){
      const row=files.get(path);return row?jsonResponse({sha:row.sha,encoding:'base64',content:Buffer.from(row.content).toString('base64')}):jsonResponse({},404);
    }
    if(method==='PUT'){
      const overridden=onPut?.(path,body);if(overridden)return overridden;
      const old=files.get(path);if(old?body.sha!==old.sha:body.sha)return jsonResponse({},409);
      assert.equal(body.author.name,'Vocabulary Builder');assert.equal(body.committer.email,'builder@users.noreply.github.com');
      assert.ok(!JSON.stringify(body).includes(TOKEN));
      put(path,Buffer.from(body.content,'base64').toString('utf8'));return jsonResponse({content:{sha:files.get(path).sha}},201);
    }
    return jsonResponse({},400);
  };
  return {files,calls,fetcher,put,setPrivate(value){privateRepo=value;},onPut(fn){onPut=fn;}};
}
const make=()=>{const db=storage(),remote=api(),statuses=[];const client=new PrivateSync({storage:db,fetcher:remote.fetcher,onStatus:value=>statuses.push(value),compressor:async()=>new Blob(['RIFF-test-webp'],{type:'image/webp'})});return {db,remote,client,statuses};};

test('credential recovery only writes to the user clipboard and never returns or uploads it',async()=>{
  const {client,db,remote}=make();await client.configure(REPO,TOKEN,false);
  const before=remote.calls.length,writes=[];
  const result=await client.copyCredential({writeText:async value=>writes.push(value)});
  assert.equal(result,undefined);assert.deepEqual(writes,[TOKEN]);assert.equal(remote.calls.length,before);
  assert.ok(!JSON.stringify(client.config).includes(TOKEN));assert.ok(!JSON.stringify(await db.exportBackup()).includes(TOKEN));
});

test('disconnected or denied clipboard recovery cannot expose credential text in errors',async()=>{
  const {client}=make();let copied=false;
  await assert.rejects(client.copyCredential({writeText:async()=>copied=true}),error=>error.code==='AUTH_REQUIRED');
  assert.equal(copied,false);await client.configure(REPO,TOKEN,false);
  await assert.rejects(client.copyCredential({writeText:async()=>{throw new Error(TOKEN);}}),error=>error.code==='CLIPBOARD_UNAVAILABLE'&&!error.message.includes(TOKEN));
  await client.disconnect();await assert.rejects(client.copyCredential({writeText:async()=>copied=true}),error=>error.code==='AUTH_REQUIRED');
  assert.equal(copied,false);
});

test('image-only cards require full content hash identities and reject foreign paths',()=>{
  assert.deepEqual(validatePrivateWords([card(SHA)]),[card(SHA)]);
  for(const bad of [{...card(SHA),image:'https://example.invalid/private.webp'},{...card(SHA),meaning:'unexpected text'},{...card(SHA),sourceHash:'short'},{...card(SHA),word:'private title'}])assert.throws(()=>validatePrivateWords([bad]));
  assert.throws(()=>validatePrivateWords([card(SHA),card(SHA)]));
});

test('progress merging takes newest records and unions history without connection metadata',()=>{
  const first=schedule({id:'hello'},'remember',100000),newer=schedule(first,'remember',200000);
  const left={...backup(),progress:[first],meta:[{key:'privateConfig',value:{token:TOKEN}}]};
  const right={...backup(),progress:[newer],activity:[{id:'2020-01-01|hello',day:'2020-01-01',wordId:'hello',reviewedAt:200000}]};
  const merged=mergeProgress(left,right);assert.equal(merged.progress[0].lastReviewedAt,200000);assert.equal(merged.activity.length,1);assert.deepEqual(merged.meta,[]);assert.ok(!JSON.stringify(merged).includes(TOKEN));
  assert.equal(left.progress[0].lastReviewedAt,100000);
});

test('init restores optional remembered credential privately and offline images without network',async()=>{
  const {db,client,remote}=make();await db.putMeta('privateConfig',{repo:REPO,remember:true,token:TOKEN});await db.putMeta('privateWords',[card(SHA)]);await db.putRecord('privateImages',{id:card(SHA).image,blob:new Blob(['webp'],{type:'image/webp'})});
  const result=await client.init();assert.equal(result.words.length,1);assert.equal(client.authenticated,true);assert.deepEqual(client.config,{repo:REPO,remember:true});assert.ok(client.imageURL(card(SHA).image).startsWith('blob:'));assert.equal(remote.calls.length,0);
  await client.disconnect();
});

test('configure does not persist a credential unless remember is explicitly enabled',async()=>{
  const {db,client}=make();await client.configure(REPO,TOKEN,false);assert.equal((await db.get('meta','privateConfig')).value.token,'');assert.equal(client.authenticated,true);assert.ok(!JSON.stringify(client.config).includes(TOKEN));
  await client.disconnect();
});

test('public repositories are blocked before any write or local credential persistence',async()=>{
  const {db,client,remote}=make();remote.setPrivate(false);
  await assert.rejects(client.configure(REPO,TOKEN,true),error=>error.code==='PUBLIC_REPO_BLOCKED');assert.equal(await db.get('meta','privateConfig'),undefined);assert.equal(remote.calls.filter(c=>c.method==='PUT').length,0);assert.equal(client.authenticated,false);
});

test('queueing is offline, hashes original bytes, deduplicates and never persists filenames',async()=>{
  const {db,client,remote}=make();await client.configure(REPO,TOKEN,false);const before=remote.calls.length;
  const file=new File(['original screenshot'],'private-person-name.png',{type:'image/png'});
  assert.deepEqual(await client.queueFiles([file,file]),{queued:1,pending:1});assert.equal(remote.calls.length,before);
  const rows=await db.all('uploadQueue');assert.equal(rows.length,1);assert.match(rows[0].id,/^[a-f0-9]{64}$/);assert.equal(rows[0].blobWebp.type,'image/webp');assert.ok(!JSON.stringify(rows).includes('private-person-name'));
});

test('image and index are published directly with anonymous commit identity and queue removed last',async()=>{
  const {db,client,remote}=make();await client.configure(REPO,TOKEN,false);await client.queueFiles([new File(['one'],'hidden.png',{type:'image/png'})]);
  const queued=(await db.all('uploadQueue'))[0],result=await client.sync();
  assert.equal(result.words.length,1);assert.equal(result.words[0].sourceHash,queued.id);assert.equal(result.pending,0);assert.equal(result.status.state,'ready');assert.equal((await db.all('uploadQueue')).length,0);
  assert.ok(remote.files.has('images/'+queued.id+'.webp'));assert.ok(remote.files.has('data/words.json'));assert.ok(!remote.calls.some(call=>call.url.includes('/inbox/')));assert.ok(client.imageURL('images/'+queued.id+'.webp').startsWith('blob:'));
  assert.equal(remote.calls.filter(call=>call.method==='PUT'&&call.url.includes('data/progress.json')).length,0);await client.disconnect();
});

test('index CAS conflicts merge a concurrent card and do not reupload completed image bytes',async()=>{
  const {db,client,remote}=make();await client.configure(REPO,TOKEN,false);await client.queueFiles([new File(['one'],'hidden.png',{type:'image/png'})]);
  let conflicted=false;remote.onPut(path=>{if(path==='data/words.json'&&!conflicted){conflicted=true;remote.put(path,[card(OTHER)]);remote.put('images/'+OTHER+'.webp','other-webp');return jsonResponse({},409);}});
  const result=await client.sync();assert.equal(result.words.length,2);assert.equal(result.pending,0);assert.equal(remote.calls.filter(call=>call.method==='PUT'&&call.url.includes('/images/')).length,1);assert.equal((await db.all('uploadQueue')).length,0);await client.disconnect();
});

test('an unsuccessful index write keeps queued screenshots and retry reuses remote image',async()=>{
  const {db,client,remote}=make();await client.configure(REPO,TOKEN,false);await client.queueFiles([new File(['one'],'hidden.png',{type:'image/png'})]);
  remote.onPut(path=>path==='data/words.json'?jsonResponse({},503):null);
  await assert.rejects(client.sync(),error=>error.code==='REQUEST_FAILED');assert.equal((await db.all('uploadQueue')).length,1);
  remote.onPut(null);await client.sync();assert.equal((await db.all('uploadQueue')).length,0);assert.equal(remote.calls.filter(call=>call.method==='PUT'&&call.url.includes('/images/')).length,1);await client.disconnect();
});

test('progress CAS retry preserves both remote and local review records without credentials',async()=>{
  const {db,client,remote}=make();await client.configure(REPO,TOKEN,true);
  remote.put('data/words.json',[card(SHA),card(OTHER)]);
  const local={...backup(),progress:[schedule({id:card(SHA).word},'remember',100000)]};db.setProgress(local);let conflicted=false;
  remote.onPut(path=>{if(path==='data/progress.json'&&!conflicted){conflicted=true;remote.put(path,{...backup(),progress:[schedule({id:card(OTHER).word},'remember',200000)]});return jsonResponse({},409);}});
  const result=await client.syncProgress();assert.deepEqual(result.progress.map(row=>row.id),[card(SHA).word,card(OTHER).word]);const content=remote.files.get('data/progress.json').content;assert.ok(!content.includes(TOKEN));assert.deepEqual(JSON.parse(content).meta,[]);assert.equal((await db.exportBackup()).progress.length,2);
});

test('repository visibility is rechecked before every sync and pending screenshots stay local',async()=>{
  const {db,client,remote}=make();await client.configure(REPO,TOKEN,false);await client.queueFiles([new File(['one'],'hidden.png',{type:'image/png'})]);remote.setPrivate(false);
  await assert.rejects(client.sync(),error=>error.code==='PUBLIC_REPO_BLOCKED');assert.equal(remote.calls.filter(c=>c.method==='PUT').length,0);assert.equal((await db.all('uploadQueue')).length,1);
});

test('disconnect removes stored token and private image cache while retaining repository-tagged pending work',async()=>{
  const {db,client}=make();await client.configure(REPO,TOKEN,true);await client.queueFiles([new File(['one'],'hidden.png',{type:'image/png'})]);await db.putMeta('privateWords',[card(SHA)]);await db.putRecord('privateImages',{id:card(SHA).image,blob:new Blob(['webp'])});
  await client.disconnect();assert.equal(client.enabled,false);assert.equal(client.authenticated,false);assert.equal(await db.get('meta','privateConfig'),undefined);assert.equal(await db.get('meta','privateWords'),undefined);assert.equal((await db.all('privateImages')).length,0);assert.equal((await db.all('uploadQueue'))[0].repo,REPO);
  await assert.rejects(client.configure('example-owner/another',TOKEN,false),error=>error.code==='QUEUED_OTHER_REPO');
});

test('invalid remote card content cannot replace a previously saved valid private word list',async()=>{
  const {db,client,remote}=make();await client.configure(REPO,TOKEN,false);await db.putMeta('privateWords',[card(SHA)]);remote.put('data/words.json',[{...card(SHA),image:'../../outside.webp'}]);
  await assert.rejects(client.sync(),error=>error.code==='INVALID_WORDS');assert.deepEqual((await db.get('meta','privateWords')).value,[card(SHA)]);assert.equal(remote.calls.filter(c=>c.method==='PUT').length,0);
});

test('repository paths reject URL injection and connection errors never reveal credentials',async()=>{
  const {client}=make();await assert.rejects(client.configure('https://example.invalid/x',TOKEN,false),error=>error.code==='INVALID_REPO');
  const broken=new PrivateSync({storage:storage(),fetcher:async()=>{throw new Error('transport secret '+TOKEN);}});
  await assert.rejects(broken.configure(REPO,TOKEN,false),error=>error.code==='NETWORK_UNAVAILABLE'&&!error.message.includes(TOKEN));
});

test('unchanged progress polling does not create repeated commits',async()=>{
  const {db,client,remote}=make();await client.configure(REPO,TOKEN,false);remote.put('data/words.json',[card(SHA)]);db.setProgress({...backup(),progress:[schedule({id:card(SHA).word},'remember',100000)]});
  await client.syncProgress();await client.syncProgress();assert.equal(remote.calls.filter(call=>call.method==='PUT'&&call.url.includes('data/progress.json')).length,1);
});

test('cloud progress excludes public-demo and other-repository records and activity',async()=>{
  const {db,client,remote}=make();await client.configure(REPO,TOKEN,false);remote.put('data/words.json',[card(SHA)]);
  const own=schedule({id:card(SHA).word},'remember',100000),foreign=schedule({id:card(OTHER).word},'remember',100000),demo=schedule({id:'hello'},'remember',100000);
  const activity=id=>({id:'2020-01-01|'+id,day:'2020-01-01',wordId:id,reviewedAt:100000});
  db.setProgress({...backup(),progress:[own,foreign,demo],activity:[activity(own.id),activity(foreign.id),activity(demo.id)]});
  await client.syncProgress();const sent=JSON.parse(remote.files.get('data/progress.json').content);
  assert.deepEqual(sent.progress.map(row=>row.id),[own.id]);assert.deepEqual(sent.activity.map(row=>row.wordId),[own.id]);
  assert.equal((await db.exportBackup()).progress.length,3,'device-local unrelated progress is retained');
});

test('foreign remote progress is not imported and is removed from this repository cloud backup',async()=>{
  const {db,client,remote}=make();await client.configure(REPO,TOKEN,false);remote.put('data/words.json',[card(SHA)]);
  remote.put('data/progress.json',{...backup(),progress:[schedule({id:'unrelated private title'},'remember',100000)]});
  const merged=await client.syncProgress();assert.deepEqual(merged.progress,[]);assert.deepEqual((await db.exportBackup()).progress,[]);
  assert.deepEqual(JSON.parse(remote.files.get('data/progress.json').content).progress,[]);
});

test('simultaneous connection changes are serialized and disconnect cannot restore an old token',async()=>{
  const db=storage(),remote=api();let release,notify;
  const waiting=new Promise(resolve=>release=resolve),started=new Promise(resolve=>notify=resolve);
  const client=new PrivateSync({storage:db,fetcher:async(url,options)=>{if(new URL(url).pathname===PREFIX){notify();await waiting;}return remote.fetcher(url,options);}});
  const configuring=client.configure(REPO,TOKEN,true);await started;
  await assert.rejects(client.configure(REPO,TOKEN,false),error=>error.code==='SYNC_BUSY');
  await client.disconnect();release();await assert.rejects(configuring,error=>error.code==='CONNECTION_CHANGED');
  assert.equal(client.enabled,false);assert.equal(client.authenticated,false);assert.equal(await db.get('meta','privateConfig'),undefined);
});

test('disconnect during the initial local queue read cannot resurrect a connection',async()=>{
  const db=storage(),remote=api();let release,notify;
  const waiting=new Promise(resolve=>release=resolve),started=new Promise(resolve=>notify=resolve),originalAll=db.all;
  db.all=async(store)=>{if(store==='uploadQueue'){notify();await waiting;}return originalAll(store);};
  const client=new PrivateSync({storage:db,fetcher:remote.fetcher});
  const configuring=client.configure(REPO,TOKEN,true);await started;await client.disconnect();release();
  await assert.rejects(configuring,error=>error.code==='CONNECTION_CHANGED');
  assert.equal(client.enabled,false);assert.equal(client.authenticated,false);assert.equal(remote.calls.length,0);
});

test('disconnect while a private cache write is pending cannot leave late private data behind',async()=>{
  const db=storage(),remote=api();let release,notify;
  const waiting=new Promise(resolve=>release=resolve),started=new Promise(resolve=>notify=resolve),originalPut=db.putMeta;
  db.putMeta=async(key,value)=>{if(key==='privateWords'&&value.length){notify();await waiting;}return originalPut(key,value);};
  const client=new PrivateSync({storage:db,fetcher:remote.fetcher});await client.configure(REPO,TOKEN,false);
  remote.put('data/words.json',[card(SHA)]);remote.put(card(SHA).image,'private-webp');
  const syncing=client.sync();await started;await client.disconnect();release();
  await assert.rejects(syncing,error=>error.code==='CONNECTION_CHANGED');
  assert.equal(await db.get('meta','privateWords'),undefined);assert.equal((await db.all('privateImages')).length,0);assert.equal(client.imageURL(card(SHA).image),null);
});

test('disconnect during an in-flight read prevents rehydrating private cache',async()=>{
  const db=storage(),remote=api();let release,notify;
  const started=new Promise(resolve=>notify=resolve),waiting=new Promise(resolve=>release=resolve);
  const client=new PrivateSync({storage:db,fetcher:async(url,options)=>{if(options.method==='GET'&&url.includes('data/words.json')){notify();await waiting;}return remote.fetcher(url,options);}});
  await client.configure(REPO,TOKEN,false);const inFlight=client.sync();await started;await client.disconnect();release();
  await assert.rejects(inFlight,error=>error.code==='CONNECTION_CHANGED');assert.equal(await db.get('meta','privateWords'),undefined);assert.equal((await db.all('privateImages')).length,0);
});
