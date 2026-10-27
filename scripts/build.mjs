import { mkdir, cp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'dist');
if(path.dirname(out)!==root || path.basename(out)!=='dist')throw new Error('Invalid build output');
await rm(out,{recursive:true,force:true});
await mkdir(out, {recursive:true});
const files = ['index.html','styles.css','app.js','core.js','db.js','private-sync.js','manifest.webmanifest','icons','images','data'];
for (const file of files) await cp(path.join(root,file),path.join(out,file),{recursive:true});
const hash = createHash('sha256');
async function hashTree(directory){for(const entry of (await readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))){const file=path.join(directory,entry.name);if(entry.isDirectory())await hashTree(file);else{hash.update(path.relative(out,file));hash.update(await readFile(file));}}}
await hashTree(out);hash.update(await readFile(path.join(root,'sw.js')));
const sw = (await readFile(path.join(root,'sw.js'),'utf8')).replace('__BUILD__', hash.digest('hex').slice(0,16));
await writeFile(path.join(out,'sw.js'),sw);
await writeFile(path.join(out,'.nojekyll'),'');
console.log('Static PWA built in dist/ (relative URLs; no secrets or Python files included).');
