import { creationIdFields, type ProductAction } from '../../shared/product';
import { randomUuid } from '../../shared/random-uuid';

type ActionInput<A = ProductAction> = A extends ProductAction
  ? Omit<
      A,
      A extends { type: 'window.open' }
        ? 'windowId' | 'tabId' | 'spaceId'
        : A extends { type: 'tab.create' }
          ? 'tabId'
          : A extends { type: 'window.place' }
            ? 'spaceId'
            : A extends { type: 'app.install' }
              ? 'appId'
              : A extends { type: 'favorite.add' }
                ? 'favoriteId'
                : never
    >
  : never;

export function buildAction<A extends ActionInput>(action: A): Extract<ProductAction, { type: A['type'] }> {
  return {
    ...action,
    ...Object.fromEntries(creationIdFields(action).map((field) => [field, randomUuid()])),
  } as unknown as Extract<ProductAction, { type: A['type'] }>;
}
