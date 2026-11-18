import http from 'node:http';
import {randomBytes,randomUUID,createHash,createPublicKey,verify} from 'node:crypto';
import {readFileSync,writeFileSync,mkdirSync,existsSync,renameSync} from 'node:fs';
const dir='.local';mkdirSync(dir,{recursive:true});
const hostPath=`${dir}/chatgpt-host.json`,credentialPath=`${dir}/chatgpt-credentials.json`;
const host=existsSync(hostPath)?JSON.parse(readFileSync(hostPath,'utf8')):{ext_agent_host_id:`urn:uuid:${randomUUID()}`};
writeFileSync(hostPath,JSON.stringify(host),{mode:0o600});
const previous=existsSync(credentialPath)?JSON.parse(readFileSync(credentialPath,'utf8')):null;
const state=randomBytes(32).toString('base64url'),nonce=randomBytes(32).toString('base64url'),verifier=randomBytes(48).toString('base64url');
const challenge=createHash('sha256').update(verifier).digest('base64url');
const redirect='http://127.0.0.1:1467/auth/callback';
const discovery=await fetch('https://auth.openai.com/.well-known/openid-configuration').then(r=>{if(!r.ok)throw new Error('OIDC discovery failed');return r.json();});
const server=http.createServer(async(req,res)=>{
  const u=new URL(req.url,redirect);if(u.pathname!=='/auth/callback'){res.writeHead(404).end();return;}
  try{
    if(u.searchParams.get('state')!==state)throw new Error('Invalid OAuth state');
    if(u.searchParams.has('error'))throw new Error(`Authorization declined: ${u.searchParams.get('error')}`);
    const clientId=u.searchParams.get('client_id')??previous?.client_id;
    if(!clientId||clientId==='dynamic_agent_client'||(previous&&clientId!==previous.client_id))throw new Error('Invalid issued client ID');
    const r=await fetch('https://auth.openai.com/api/accounts/oauth/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',client_id:clientId,code:u.searchParams.get('code'),code_verifier:verifier,redirect_uri:redirect,resource:'https://api.openai.com/v1'})});
    if(!r.ok)throw new Error(`Token exchange HTTP ${r.status}`);const tokens=await r.json();
    const [header,payload,signature]=tokens.id_token.split('.'),h=JSON.parse(Buffer.from(header,'base64url')),claims=JSON.parse(Buffer.from(payload,'base64url'));
    if(h.alg!=='RS256')throw new Error('Unexpected ID-token algorithm');
    const keys=await fetch(discovery.jwks_uri).then(r=>r.json()),jwk=keys.keys.find(k=>k.kid===h.kid);
    if(!jwk||!verify('RSA-SHA256',Buffer.from(`${header}.${payload}`),createPublicKey({key:jwk,format:'jwk'}),Buffer.from(signature,'base64url')))throw new Error('Invalid ID-token signature');
    const aud=Array.isArray(claims.aud)?claims.aud:[claims.aud];
    if(claims.iss!==discovery.issuer||!aud.includes(clientId)||claims.exp*1000<=Date.now()||claims.nonce!==nonce||!claims.sub)throw new Error('Invalid ID-token claims');
    if(previous&&claims.sub!==previous.subject)throw new Error('Wrong ChatGPT account');
    const scopes=(tokens.scope??'').split(' ');if(!scopes.includes('chatgpt.tokens.use.direct'))throw new Error('ChatGPT plan permission not granted');
    const saved={...tokens,client_id:clientId,ext_agent_host_id:host.ext_agent_host_id,issuer:claims.iss,subject:claims.sub,email:claims.email,scopes,saved_at:new Date().toISOString()};
    writeFileSync(`${credentialPath}.tmp`,JSON.stringify(saved),{mode:0o600});renameSync(`${credentialPath}.tmp`,credentialPath);
    res.writeHead(200,{'content-type':'text/html; charset=utf-8'}).end('<h1>ai is connected to your ChatGPT plan</h1><p>You can close this tab. Manage app access and usage in ChatGPT settings.</p>');
    console.log('ChatGPT plan connected. Credentials stored privately; no tokens printed.');server.close();
  }catch(e){res.writeHead(400,{'content-type':'text/plain'}).end(e.message);console.error(e.message);}
});
server.listen(1467,'127.0.0.1',()=>{
  const u=new URL('https://auth.openai.com/api/accounts/authorize');
  const p={client_id:previous?.client_id??'dynamic_agent_client',ext_agent_host_id:host.ext_agent_host_id,response_type:'code',redirect_uri:redirect,scope:'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',resource:'https://api.openai.com/v1',state,nonce,code_challenge_method:'S256',code_challenge:challenge,...(previous?{id_token_hint:previous.id_token}:{agent_name_hint:'ai'})};
  u.search=new URLSearchParams(p);writeFileSync(`${dir}/chatgpt-login-url.txt`,u.href,{mode:0o600});console.log('Authorization listener ready on 127.0.0.1:1467.');
});
setTimeout(()=>{server.close();process.exit(1);},15*60*1000).unref();
