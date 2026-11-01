// No browser/GPU/network: compare concurrent and serialized large JSONL appends.
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const directory=resolve(process.argv[2]??`develop/tmp/metrics-append-repro-${Date.now()}`);
await mkdir(directory,{recursive:false});
const records=Array.from({length:4},(_,peer)=>({peer,payload:String.fromCharCode(65+peer).repeat(700000),tail:`END-${peer}`}));
const parallel=join(directory,'parallel.jsonl'),serial=join(directory,'serialized.jsonl');
await Promise.all(records.map(row=>appendFile(parallel,JSON.stringify(row)+'\n')));
for(const row of records)await appendFile(serial,JSON.stringify(row)+'\n');
async function inspect(path){
 const bytes=await readFile(path),lines=bytes.toString('utf8').trimEnd().split('\n');let invalid=0;const peers=[];
 for(const line of lines){try{const row=JSON.parse(line);if(row.payload!==records[row.peer]?.payload||row.tail!==`END-${row.peer}`)throw Error('mixed record');peers.push(row.peer);}catch{invalid++;}}
 return{bytes:bytes.length,lines:lines.length,invalidRecords:invalid,validPeers:peers};
}
const result={directory,node:process.version,recordPayloadBytes:700000,parallel:await inspect(parallel),serialized:await inspect(serial)};
await writeFile(join(directory,'summary.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
