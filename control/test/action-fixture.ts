import assert from 'node:assert/strict';
import { creationIdFields } from '../shared/product';

export function assertActionShape(actual: unknown, expected: unknown) {
  function shape(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(shape);
    if (!value || typeof value !== 'object') return value;
    const fields = new Set<string>(creationIdFields(value as { type: string }));
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, item]) => {
        if (!fields.has(key)) return [[key, shape(item)]];
        assert.match(item as string, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        return [];
      }),
    );
  }
  assert.deepEqual(shape(actual), shape(expected));
}
