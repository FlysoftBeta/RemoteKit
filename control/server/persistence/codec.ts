import { RemoteKitError } from '../../shared/errors';

export interface Codec<T> {
  read(value: unknown, path: string): T;
}
export type Decoded<C> = C extends Codec<infer T> ? T : never;
type Fields = Record<string, Codec<unknown>>;
type RequiredFields<F extends Fields> = { [K in keyof F]: Decoded<F[K]> };
type OptionalFields<F extends Fields> = { [K in keyof F]?: Decoded<F[K]> };

function fail(path: string, expected: string): never {
  throw new Error(`${path} expected ${expected}`);
}
export function string(options: { pattern?: RegExp } = {}): Codec<string> {
  return {
    read: (value, path) =>
      typeof value === 'string' && (!options.pattern || options.pattern.test(value))
        ? value
        : fail(path, options.pattern ? `string matching ${options.pattern}` : 'string'),
  };
}
export function number(): Codec<number> {
  return {
    read: (value, path) =>
      typeof value === 'number' && Number.isFinite(value) ? value : fail(path, 'finite number'),
  };
}
export function integer(): Codec<number> {
  return {
    read: (value, path) =>
      typeof value === 'number' && Number.isSafeInteger(value) ? value : fail(path, 'safe integer'),
  };
}
export function boolean(): Codec<boolean> {
  return { read: (value, path) => (typeof value === 'boolean' ? value : fail(path, 'boolean')) };
}
export function literal<const T extends readonly (string | number | boolean | null)[]>(
  ...values: T
): Codec<T[number]> {
  return {
    read: (value, path) =>
      values.includes(value as T[number]) ? (value as T[number]) : fail(path, values.map(String).join('|')),
  };
}
export function array<T>(of: Codec<T>, options: { max?: number } = {}): Codec<T[]> {
  return {
    read(value, path) {
      if (!Array.isArray(value) || (options.max !== undefined && value.length > options.max))
        return fail(path, `array${options.max === undefined ? '' : ` of at most ${options.max}`}`);
      return value.map((item, index) => of.read(item, `${path}[${index}]`));
    },
  };
}
export function object<R extends Fields>(required: R): Codec<RequiredFields<R>>;
export function object<R extends Fields, O extends Fields>(
  required: R,
  optional: O,
): Codec<RequiredFields<R> & OptionalFields<O>>;
export function object(required: Fields, optional: Fields = {}): Codec<Record<string, unknown>> {
  return {
    read(value, path) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return fail(path, 'object');
      const input = value as Record<string, unknown>;
      const result: Record<string, unknown> = {};
      for (const key of Object.keys(input)) {
        if (
          !Object.prototype.hasOwnProperty.call(required, key) &&
          !Object.prototype.hasOwnProperty.call(optional ?? {}, key)
        )
          fail(`${path}.${key}`, 'known key');
      }
      for (const [key, codec] of Object.entries(required))
        result[key] = codec.read(input[key], `${path}.${key}`);
      for (const [key, codec] of Object.entries(optional ?? {})) {
        if (input[key] !== undefined) result[key] = codec.read(input[key], `${path}.${key}`);
      }
      return result;
    },
  };
}
export function record<T>(of: Codec<T>): Codec<Record<string, T>> {
  return {
    read(value, path) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return fail(path, 'record');
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, of.read(item, `${path}.${key}`)]),
      );
    },
  };
}
export function nullable<T>(of: Codec<T>): Codec<T | null> {
  return union(literal(null), of);
}
export function union<const C extends readonly Codec<unknown>[]>(...choices: C): Codec<Decoded<C[number]>> {
  return {
    read(value, path) {
      const failures: string[] = [];
      for (const choice of choices) {
        try {
          return choice.read(value, path) as Decoded<C[number]>;
        } catch (error) {
          failures.push((error as Error).message);
        }
      }
      throw new Error(failures.join('; '));
    },
  };
}
export const jsonValue: Codec<unknown> = {
  read(value, path): unknown {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') return number().read(value, path);
    if (Array.isArray(value)) return array(jsonValue).read(value, path);
    return record(jsonValue).read(value, path);
  },
};
export function corruptRecord(where: string, error: unknown): RemoteKitError {
  if (error instanceof RemoteKitError && error.reason === 'corrupt_record') return error;
  return new RemoteKitError('internal', '数据记录已损坏，请联系管理员', {
    reason: 'corrupt_record',
    detail: `${where}: ${(error as Error).message}`,
    cause: error,
  });
}
export function decodeJson<T>(text: string, codec: Codec<T>, where: string): T {
  try {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new Error('$ expected valid JSON');
    }
    return codec.read(value, '$');
  } catch (error) {
    throw corruptRecord(where, error);
  }
}
export function encodeJson<T>(value: NoInfer<T>, codec: Codec<T>, where: string): string {
  try {
    return JSON.stringify(codec.read(value, '$'));
  } catch (error) {
    throw corruptRecord(where, error);
  }
}
