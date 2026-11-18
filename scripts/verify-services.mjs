// Execute inside the control container with its existing environment.
import {Client} from './src/client.mjs';
const e=process.env, c=new Client('http://127.0.0.1:8787',e.OWNER_TOKEN);
const s=await c.request('/status');console.log(JSON.stringify({panic:s.panic,committedUsd:s.committedUsd,activeCalls:s.activeCalls,goals:s.goals,state:s.state}));
const api=await fetch('http://hindsight:8888/openapi.json').then(r=>r.json());
console.log('Hindsight memory routes:',Object.keys(api.paths).filter(p=>/memories|recall/.test(p)).slice(0,12));
const r=await fetch('http://langfuse-web:3000/api/public/v2/observations?limit=5&fields=core,basic,usage',{headers:{authorization:`Basic ${Buffer.from(`${e.LANGFUSE_PUBLIC_KEY}:${e.LANGFUSE_SECRET_KEY}`).toString('base64')}`}});
const result=await r.json();console.log('Langfuse:',JSON.stringify({status:r.status,observations:result.data?.map(t=>({id:t.id,name:t.name,model:t.providedModelName,usage:t.usageDetails})),error:result.message}));
console.log('Recent errors:',JSON.stringify((await c.request('/events')).filter(x=>/error|failed|violation/.test(x.kind)).slice(0,6)));
