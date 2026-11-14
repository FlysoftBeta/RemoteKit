import { StringDecoder } from 'node:string_decoder';
import { log } from '../log';

export class EndpointLog {
  private readonly decoder = new StringDecoder('utf8');
  private pending = '';
  constructor(
    private readonly childPid: number | undefined,
    private readonly stream = 'stderr',
    private readonly child = 'endpoint',
  ) {}
  write(bytes: Buffer) {
    this.split(this.decoder.write(bytes));
  }
  flush() {
    this.split(this.decoder.end());
    if (this.pending) this.emit(this.pending);
    this.pending = '';
  }
  private split(text: string) {
    this.pending += text;
    while (this.pending.length) {
      const end = this.pending.indexOf('\n');
      if (end >= 0 && end < 8192) {
        this.emit(this.pending.slice(0, end).replace(/\r$/, ''));
        this.pending = this.pending.slice(end + 1);
      } else if (this.pending.length >= 8192) {
        this.emit(this.pending.slice(0, 8192));
        this.pending = this.pending.slice(8192);
      } else break;
    }
  }
  private emit(text: string) {
    log.warn('process.output', { child: this.child, childPid: this.childPid, stream: this.stream, text });
  }
}
