import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
export class CodexRpc {
  constructor(binary='codex',args=[]) {
    this.pending=new Map();this.id=0;
    this.child=spawn(binary,[...args,'app-server','--listen','stdio://'],{stdio:['pipe','pipe','pipe'],windowsHide:true});
    this.child.stderr.resume();
    this.lines=createInterface({input:this.child.stdout});
    this.lines.on('line',line=>{
      let message;try{message=JSON.parse(line);}catch{return;}
      if(message.id!==undefined&&message.method){this.child.stdin.write(JSON.stringify({id:message.id,error:{code:-32601,message:'Unsupported host request'}})+'\n');return;}
      const p=this.pending.get(message.id);
      if(p){clearTimeout(p.timer);this.pending.delete(message.id);message.error?p.reject(new Error(message.error.message)):p.resolve(message.result);}
    });
    const fail=()=>{for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(new Error('Codex process exited'));}this.pending.clear();};
    this.child.on('error',fail);this.child.on('exit',fail);
  }
  request(method,params={}) {
    return new Promise((resolve,reject)=>{
      const id=++this.id,timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`Codex timeout: ${method}`));},30000);
      this.pending.set(id,{resolve,reject,timer});
      this.child.stdin.write(JSON.stringify({id,method,params})+'\n',e=>{if(e){clearTimeout(timer);this.pending.delete(id);reject(e);}});
    });
  }
  async initialize(){await this.request('initialize',{clientInfo:{name:'ai-personal-runtime',version:'0.1.0'},capabilities:{experimentalApi:true}});this.child.stdin.write(JSON.stringify({method:'initialized',params:{}})+'\n');}
  close(){this.child.stdin.end();this.lines.close();this.child.kill();}
}
