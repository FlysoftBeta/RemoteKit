import { randomUUID } from 'node:crypto';
import type { buildAction as buildClientAction } from '../../../control/client/control/action-builder.ts';
import { creationIdFields, type ProductAction } from '../../../control/shared/product.ts';

export function buildAction(action: Parameters<typeof buildClientAction>[0]): ProductAction {
  return {
    ...action,
    ...Object.fromEntries(creationIdFields(action).map((field) => [field, randomUUID()])),
  } as ProductAction;
}
