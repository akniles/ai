// Run in the control container, which already holds the Langfuse project keys.
import {readFile} from 'node:fs/promises';
import {promptNames,releaseName} from '../src/prompts.mjs';
const e=process.env,label=process.argv.find(a=>a.startsWith('--label='))?.slice(8)??'production';
if(!e.LANGFUSE_URL||!e.LANGFUSE_PUBLIC_KEY||!e.LANGFUSE_SECRET_KEY)throw new Error('Langfuse connection missing');
const headers={authorization:`Basic ${Buffer.from(`${e.LANGFUSE_PUBLIC_KEY}:${e.LANGFUSE_SECRET_KEY}`).toString('base64')}`,'content-type':'application/json'};
async function publish(name,prompt){
  const url=`${e.LANGFUSE_URL}/api/public/v2/prompts`;
  const previous=await fetch(`${url}/${encodeURIComponent(name)}?${new URLSearchParams({label})}`,{headers,signal:AbortSignal.timeout(10000)});
  if(previous.ok){const p=await previous.json();if(p.type==='text'&&p.prompt===prompt){console.log(`${name}: unchanged v${p.version}`);return p.version;}}
  else if(previous.status!==404)throw new Error(`Prompt read HTTP ${previous.status}`);
  const r=await fetch(url,{method:'POST',headers,body:JSON.stringify({name,type:'text',prompt,labels:[label],tags:['ai-harness'],commitMessage:'Updated by scripts/publish-prompts.mjs'}),signal:AbortSignal.timeout(10000)});
  if(!r.ok)throw new Error(`Prompt publish ${name} HTTP ${r.status}`);const p=await r.json();console.log(`${name}: published v${p.version}`);return p.version;
}
const manifest={};for(const name of promptNames)manifest[name]=await publish(name,(await readFile(new URL(`../prompts/${name}.txt`,import.meta.url),'utf8')).replaceAll('\r\n','\n').trim());
// The runtime resolves this manifest first and fetches every member by version.
// Publishing the manifest last makes partial updates invisible to the runtime.
await publish(releaseName,JSON.stringify(manifest));
if(e.OWNER_TOKEN){const r=await fetch('http://127.0.0.1:8787/prompts/refresh',{method:'POST',headers:{authorization:`Bearer ${e.OWNER_TOKEN}`},signal:AbortSignal.timeout(15000)});if(!r.ok)throw new Error('Prompt cache refresh failed');const result=await r.json();console.log(`Runtime loaded release v${result.releaseVersion}`);}
