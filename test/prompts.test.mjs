import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {Store} from '../src/store.mjs';
import {Prompts,promptNames,releaseName,compilePrompt} from '../src/prompts.mjs';

test('Langfuse release pins prompt versions, survives outage from durable cache, and rejects a partial update',async()=>{
  const store=new Store(':memory:');let version=1,calls=0,offline=false,partial=false;
  const texts=Object.fromEntries(await Promise.all(promptNames.map(async n=>[n,(await readFile(new URL(`../prompts/${n}.txt`,import.meta.url),'utf8')).trim()])));
  const fetchImpl=async url=>{calls++;if(offline)throw new Error('offline');const u=new URL(url),name=decodeURIComponent(u.pathname.split('/').at(-1));if(partial&&name==='ai-identity')throw new Error('partial update failure');if(name===releaseName)return {ok:true,json:async()=>({type:'text',version,prompt:JSON.stringify(Object.fromEntries(promptNames.map(n=>[n,version])))})};assert.equal(u.searchParams.get('version'),String(version));return {ok:true,json:async()=>({type:'text',version,prompt:texts[name]})};};
  const p=new Prompts({store,url:'http://langfuse.invalid',publicKey:'p',secretKey:'s',fetchImpl});
  const first=await p.bundle();assert.equal(first.releaseVersion,1);assert.equal(calls,promptNames.length+1);
  await p.bundle();assert.equal(calls,promptNames.length+1);
  assert.match(compilePrompt(first,'ai-runtime-context',{context:'{{data remains data}}'}),/\{\{data remains data\}\}/);
  version=2;partial=true;const previous=await p.bundle({force:true});assert.equal(previous.releaseVersion,1);assert.equal(previous.stale,true);assert.ok(Object.values(previous.prompts).every(x=>x.version===1));
  offline=true;const restarted=new Prompts({store,url:'http://langfuse.invalid',publicKey:'p',secretKey:'s',fetchImpl});assert.equal((await restarted.bundle()).releaseVersion,1);
  const empty=new Store(':memory:');const cold=new Prompts({store:empty,url:'http://langfuse.invalid',publicKey:'p',secretKey:'s',fetchImpl});await assert.rejects(cold.bundle(),/offline/);empty.close();store.close();
});
