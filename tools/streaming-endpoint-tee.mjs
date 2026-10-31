// Optional diagnostic transport: forwards the existing JSONL protocol unchanged.
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
const [logPath, executable, ...args] = process.argv.slice(2);
if (!logPath || !executable) throw new Error('Expected log path and endpoint executable');
const log=createWriteStream(logPath,{flags:'wx'});
const child=spawn(executable,args,{windowsHide:true,stdio:['pipe','pipe','pipe']});
process.stdin.pipe(child.stdin);
child.stdout.on('data',chunk=>{process.stdout.write(chunk);log.write(chunk)});
child.stderr.pipe(process.stderr);
child.on('error',error=>{console.error(error);process.exitCode=1;log.end()});
child.on('exit',code=>{process.exitCode=code??1;process.stdin.pause();log.end()});
