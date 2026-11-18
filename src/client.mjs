export class Client {
  constructor(url,token,context) { this.url=url; this.token=token; this.context=context; }
  withContext(context) { return new Client(this.url,this.token,context); }
  async request(path,body) {
    const r=await fetch(`${this.url}${path}`,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${this.token}`,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify({...body,...(this.context?{_context:this.context}:{})}),signal:AbortSignal.timeout(190000)});
    const result=await r.json(); if (!r.ok) throw new Error(result.error ?? `HTTP ${r.status}`); return result;
  }
  action(name,args={}) { return this.request('/runtime/action',{...args,name}); }
}
