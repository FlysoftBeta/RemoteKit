import type { SocketMethods as ProductSocketMethods } from '../../shared/product';

export type ErrorSearchResult = { records: { source: string; line: string }[]; unreachable: string[] };
export interface ErrorSearchMethods {
  'admin.findError': { params: { errorId: string }; result: ErrorSearchResult };
}
export type SocketMethods = ProductSocketMethods & ErrorSearchMethods;
