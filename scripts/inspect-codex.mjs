import {CodexRpc} from '../src/codex-rpc.mjs';
const rpc=new CodexRpc(process.env.CODEX_BIN ?? 'codex');
try{
  await rpc.initialize();
  const account=await rpc.request('account/read',{refreshToken:false});
  console.log(JSON.stringify({authType:account.account?.type,plan:account.account?.planType}));
  console.log(JSON.stringify(await rpc.request('account/rateLimits/read')));
  const models=await rpc.request('model/list',{});
  console.log(JSON.stringify(models.data?.map(m=>({id:m.id,model:m.model,isDefault:m.isDefault,supportedReasoningEfforts:m.supportedReasoningEfforts}))));
}finally{rpc.close();}
