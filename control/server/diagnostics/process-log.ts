// Control has no log file: its stdout/stderr go wherever the launcher points
// them. Keep the most recent output in memory so a diagnostic archive can
// include it without depending on how the service was started.
export class ProcessLog {
  private chunks: Buffer[] = [];
  private bytes = 0;
  private dropped = 0;

  constructor(private readonly capacity: number) {}

  install(streams: readonly NodeJS.WriteStream[] = [process.stdout, process.stderr]) {
    for (const stream of streams) {
      const write = stream.write.bind(stream) as (...args: unknown[]) => boolean;
      stream.write = ((chunk: unknown, ...rest: unknown[]) => {
        if (typeof chunk === 'string' || chunk instanceof Uint8Array)
          this.append(
            typeof chunk === 'string'
              ? Buffer.from(chunk, typeof rest[0] === 'string' ? (rest[0] as BufferEncoding) : 'utf8')
              : Buffer.from(chunk),
          );
        return write(chunk, ...rest);
      }) as typeof stream.write;
    }
  }

  append(chunk: Buffer) {
    if (chunk.length >= this.capacity) {
      this.dropped += this.bytes + chunk.length - this.capacity;
      this.chunks = [chunk.subarray(chunk.length - this.capacity)];
      this.bytes = this.capacity;
      return;
    }
    this.chunks.push(chunk);
    this.bytes += chunk.length;
    while (this.bytes > this.capacity) {
      const first = this.chunks[0];
      const excess = this.bytes - this.capacity;
      if (first.length <= excess) {
        this.chunks.shift();
        this.bytes -= first.length;
        this.dropped += first.length;
      } else {
        this.chunks[0] = first.subarray(excess);
        this.bytes -= excess;
        this.dropped += excess;
      }
    }
  }

  // `dropped` counts evicted bytes; the first retained line may be partial.
  snapshot() {
    return { data: Buffer.concat(this.chunks), dropped: this.dropped };
  }
}
