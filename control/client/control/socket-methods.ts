import type { SocketMethods as ProductSocketMethods } from '../../shared/product';

import type { ErrorSearchResult } from '../../shared/admin';
export type { ErrorSearchResult } from '../../shared/admin';
export interface ErrorSearchMethods {
  'admin.findError': { params: { errorId: string }; result: ErrorSearchResult };
}
export type SocketMethods = ProductSocketMethods & ErrorSearchMethods;
