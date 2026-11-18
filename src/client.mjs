export class Client {
  constructor(url,token) { this.url=url; this.token=token; }
  async request(path,body) {
    const r=await fetch(`${this.url}${path}`,{method:body===undefined?'GET':'POST',headers:{authorization:`Bearer ${this.token}`,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(190000)});
    const result=await r.json(); if (!r.ok) throw new Error(result.error ?? `HTTP ${r.status}`); return result;
  }
  action(name,args={}) { return this.request('/runtime/action',{...args,name}); }
}
