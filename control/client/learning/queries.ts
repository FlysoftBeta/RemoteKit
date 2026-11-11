import { formatError } from '../util/format-error';
import { RemoteKitError } from '../../shared/errors';
import { retryDelay, errorHandling } from '../../shared/error-policy';
import type { LearningPage, LearningSocketMethods } from '../../shared/learning';
import { useEffect, useRef, useState } from 'react';

export type LearningCall = <K extends keyof LearningSocketMethods>(
  method: K,
  params: LearningSocketMethods[K]['params'],
) => Promise<LearningSocketMethods[K]['result']>;

export class LearningQueries {
  private readonly cache = new Map<string, Promise<unknown>>();
  constructor(readonly call: LearningCall) {}
  get<K extends keyof LearningSocketMethods>(
    method: K,
    params: LearningSocketMethods[K]['params'],
  ): Promise<LearningSocketMethods[K]['result']> {
    const key = JSON.stringify([method, params]);
    let result = this.cache.get(key);
    if (!result) {
      const read = async () => {
        for (let attempt = 0; ; attempt++) {
          try {
            return await this.call(method, params);
          } catch (error) {
            const delay = error instanceof RemoteKitError ? retryDelay(error, attempt) : undefined;
            if (delay === undefined || attempt >= 3) throw error;
            await new Promise((resolve) => setTimeout(resolve, delay));
          }
        }
      };
      result = read().catch((error) => {
        this.cache.delete(key);
        throw error;
      });
      this.cache.set(key, result);
    }
    return result as Promise<LearningSocketMethods[K]['result']>;
  }
  clear() {
    this.cache.clear();
  }
}

export function useQuery<T>(key: string, load: () => Promise<T>, enabled = true) {
  const latest = useRef(load);
  latest.current = load;
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ key: string; value?: T; error?: string; retryable?: boolean }>({
    key,
  });
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    setState({ key });
    void latest.current().then(
      (value) => active && setState({ key, value }),
      (error) =>
        active &&
        setState({
          key,
          error: formatError(error),
          retryable:
            error instanceof RemoteKitError &&
            (retryDelay(error, 0) !== undefined || errorHandling(error.code) === 'reconcile'),
        }),
    );
    return () => {
      active = false;
    };
  }, [key, enabled, attempt]);
  return {
    ...(state.key === key ? state : { key }),
    retry: () => {
      if (state.retryable) setAttempt((value) => value + 1);
    },
  };
}

export function usePaged<T>(key: string, load: (page: number) => Promise<LearningPage<T>>, enabled: boolean) {
  const [page, setPage] = useState({ key, page: 1 });
  if (page.key !== key) setPage({ key, page: 1 });
  const current = page.key === key ? page.page : 1;
  const query = useQuery(`${key}:${current}`, () => load(current), enabled);
  const [collected, setCollected] = useState<{
    key: string;
    items: T[];
    page: number;
    value?: LearningPage<T>;
  }>({
    key,
    items: [],
    page: 0,
  });
  useEffect(() => {
    if (!query.value) return;
    setCollected((previous) => ({
      key,
      page: current,
      value: query.value,
      items:
        current === 1 || previous.key !== key
          ? query.value!.items
          : [...previous.items, ...query.value!.items],
    }));
  }, [query.value, key, current]);
  return {
    ...query,
    value: query.value ?? (collected.key === key ? collected.value : undefined),
    items: collected.key === key ? collected.items : [],
    loading: enabled && !query.value && !query.error,
    next: () => {
      if (
        query.value &&
        current < query.value.pageCount &&
        collected.key === key &&
        collected.page === current
      )
        setPage({ key, page: current + 1 });
    },
  };
}
