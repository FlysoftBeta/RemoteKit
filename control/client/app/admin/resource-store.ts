import { RemoteKitError } from '../../../shared/errors';
import { failureError } from '../../failures';
import { recover } from '../../failures/recovery';
import { diagnostics } from '../../media/diagnostics';
import { Store } from '../../util/store';

type Projection<T> = (snapshot: T) => T;
export class AdminResourceStore<T> extends Store<{ data: T | null; error?: RemoteKitError }> {
  private server: T | null = null;
  private pending: { project: Projection<T>; visible: boolean }[] = [];
  private generation = 0;
  private tail: Promise<unknown> = Promise.resolve();
  private abort = new AbortController();
  private loadError?: RemoteKitError;
  private mutationError?: RemoteKitError;
  constructor(private load: () => Promise<T>) {
    super({ data: null });
  }
  setLoader(load: () => Promise<T>) {
    this.load = load;
  }
  activate() {
    if (this.abort.signal.aborted) this.abort = new AbortController();
  }
  private emit() {
    this.publish({
      data:
        this.server === null
          ? null
          : this.pending.reduce<T>(
              (data, change) => (change.visible ? change.project(data) : data),
              this.server,
            ),
      error: this.mutationError ?? this.loadError,
    });
  }
  refresh = async () => {
    const generation = this.generation;
    try {
      const next = await this.load();
      if (generation === this.generation && !this.abort.signal.aborted) {
        this.server = next;
        this.loadError = undefined;
        this.emit();
      }
    } catch (cause) {
      if (generation === this.generation) {
        this.loadError = failureError(cause);
        this.emit();
      }
      throw cause;
    }
  };
  mutate = (
    project: Projection<T>,
    work: () => Promise<T>,
    options: { retry?: boolean; identity?: string } = {},
  ) => {
    const pending = { project, visible: true };
    this.pending.push(pending);
    this.generation++;
    this.mutationError = undefined;
    this.emit();
    const execute = async () => {
      if (this.abort.signal.aborted) return;
      try {
        const attempt = () => {
          pending.visible = true;
          this.emit();
          return work();
        };
        const next = options.retry
          ? await recover(
              attempt,
              this.abort.signal,
              (error) => {
                pending.visible = false;
                this.mutationError = error;
                this.emit();
              },
              { identity: options.identity },
            )
          : await attempt();
        if (this.abort.signal.aborted) return;
        this.server = next;
        this.pending = this.pending.filter((change) => change !== pending);
        this.generation++;
        this.mutationError = undefined;
        this.emit();
      } catch (cause) {
        if (this.abort.signal.aborted) return;
        this.pending = this.pending.filter((change) => change !== pending);
        this.generation++;
        const error = failureError(cause);
        this.mutationError = error;
        this.emit();
        await this.refresh().catch((failure) => diagnostics.record('admin-rollback', failure));
        this.mutationError = error;
        this.emit();
      }
    };
    const result = this.tail.then(execute);
    this.tail = result;
    return result;
  };
  dispose = () => {
    this.abort.abort();
    this.generation++;
  };
}
