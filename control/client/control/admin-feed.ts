import { Events } from '../util/store';

/** The server names the admin resources that changed so the console reads them now. */
export const adminFeed = new Events<string[]>();
