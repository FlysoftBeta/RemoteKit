import { createInterface } from 'node:readline';
import { startJourney } from './files-user-session.mjs';
process.env.FILES_PORT = process.env.FILES_PORT ?? '34260';
let j = await startJourney(process.argv[2] ?? 'edge', process.argv[3] ?? 'mouse');
console.log('JOURNEY', j.run);
const input = createInterface({ input: process.stdin, terminal: false });
for await (const code of input) {
  if (code === 'exit') {
    await j.close();
    break;
  }
  try {
    console.log('RESULT', JSON.stringify(await eval(`(async () => { ${code} })()`)));
  } catch (error) {
    console.log('ERROR', error.stack);
    await j.shot('failure-' + Date.now()).catch(() => {});
  }
}
