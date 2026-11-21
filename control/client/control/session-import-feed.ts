import type { SessionImportState } from '../../shared/session-import';
import { Events } from '../util/store';

/** The server pushes the import state when it changes; null asks for one read after a reconnect. */
export const sessionImportFeed = new Events<SessionImportState | null>();
