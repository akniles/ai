import http from 'node:http';
import {readFile} from 'node:fs/promises';
const e=process.env;
const files={'/':['index.html','text/html; charset=utf-8'],'/app.js':['app.js','text/javascript; charset=utf-8'],'/style.css':['style.css','text/css; charset=utf-8']};
const server=http.createServer(async(req,res)=>{
  const headers={'x-content-type-options':'nosniff','referrer-policy':'strict-origin-when-cross-origin','content-security-policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'"};
  try{
    const path=new URL(req.url,'http://localhost').pathname;
    if(req.method!=='GET'){res.writeHead(405,headers).end();return;}
    if(path==='/api/live'||/^\/api\/traces\/[a-f0-9]{32}$/.test(path)) {
      const target=path==='/api/live'?'/public':path.replace('/api/','/public/');
      const r=await fetch(`${e.CONTROL_URL??'http://control:8787'}${target}`,{headers:{authorization:`Bearer ${e.PUBLIC_VIEW_TOKEN}`},signal:AbortSignal.timeout(10000)});
      if(!r.ok)throw new Error('Agent feed unavailable');
      const data=await r.json();if(path==='/api/live'){data.linkedin=e.LINKEDIN_URL??null;data.langfuse=e.LANGFUSE_PUBLIC_URL??null;}
      res.writeHead(200,{...headers,'content-type':'application/json','cache-control':'no-store'}).end(JSON.stringify(data));return;
    }
    if(!files[path]){res.writeHead(404,headers).end('Not found');return;}
    const [file,type]=files[path],data=await readFile(new URL(`../web/${file}`,import.meta.url));
    res.writeHead(200,{...headers,'content-type':type,'cache-control':'public, max-age=60'}).end(data);
  }catch{res.writeHead(503,{...headers,'content-type':'application/json','cache-control':'no-store'}).end(JSON.stringify({error:'Live feed temporarily unavailable'}));}
});
server.listen(Number(e.PORT??8080),'0.0.0.0',()=>console.log('Agent website listening'));
