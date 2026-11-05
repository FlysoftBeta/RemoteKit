import { Store } from '../util/store';

export class DiagnosticEvents extends Store<{
  count: number;
  malformed: number;
  last?: { kind: string; error: string };
}> {
  constructor() {
    super({ count: 0, malformed: 0 });
  }
  record(kind: string, error: unknown) {
    const current = this.getSnapshot();
    this.publish({
      count: current.count + 1,
      malformed: current.malformed + (kind === 'malformed-message' ? 1 : 0),
      last: { kind, error: String(error) },
    });
  }
}
export const diagnostics = new DiagnosticEvents();
