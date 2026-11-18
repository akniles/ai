import { Client } from './client.mjs';
const [command='status',...args]=process.argv.slice(2);
const client=new Client(process.env.CONTROL_URL ?? 'http://127.0.0.1:8787',process.env.OWNER_TOKEN);
try {
  const paths={status:'/status',events:'/events',outbox:'/outbox',panic:'/panic',resume:'/resume',send:'/inbox'};
  if(!paths[command])throw new Error('Commands: status, events, outbox, panic, resume, send <chat> <sender> <text>');
  const body=command==='send'?{chat:args[0],sender:args[1],body:args.slice(2).join(' ')}:['panic','resume'].includes(command)?{}:undefined;
  console.log(JSON.stringify(await client.request(paths[command],body),null,2));
}catch(e){console.error(e.message);process.exitCode=1;}
