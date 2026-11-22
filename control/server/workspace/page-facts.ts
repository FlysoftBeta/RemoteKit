import type { ProductTab } from '../../shared/product';
import { isLocalTab } from '../../shared/product';

/**
 * Applies what the Browser reports about a page to its tab: title, load state, history
 * availability and address. The address is only taken when no navigation of ours is still
 * waiting for its terminal result. Returns whether the tab changed.
 */
export function projectPageFacts(tab: ProductTab, current: any): boolean {
  let changed = false;
  const set = <K extends 'title' | 'loading' | 'canGoBack' | 'canGoForward' | 'url'>(
    key: K,
    value: ProductTab[K],
  ) => {
    if (tab[key] === value) return;
    tab[key] = value;
    changed = true;
  };
  if (typeof current.title === 'string') set('title', current.title.slice(0, 120));
  for (const key of ['loading', 'canGoBack', 'canGoForward'] as const)
    if (typeof current[key] === 'boolean') set(key, current[key]);
  if (
    (!tab.navigation ||
      tab.navigation.resolved ||
      !['applying', 'unknown'].includes(tab.navigation.status)) &&
    typeof current.url === 'string' &&
    /^(https?:\/\/|about:blank$)/.test(current.url) &&
    (!tab.pendingUrl || current.url === tab.pendingUrl)
  ) {
    set('url', current.url);
    if (tab.pendingUrl !== undefined) {
      delete tab.pendingUrl;
      changed = true;
    }
  }
  return changed;
}

/**
 * Whether an observed view's facts can be projected without the lifecycle bookkeeping of a full
 * reconciliation: a page that is being recovered, restored or closed, or whose popup is not yet
 * adopted, is left to it.
 */
export function pageFactsProjectable(tab: ProductTab, current: any): boolean {
  return (
    !isLocalTab(tab) &&
    !tab.signIn &&
    !tab.restoring &&
    !tab.lifecycleRecovery &&
    !tab.lifecycleRecoveryError &&
    tab.popup?.status !== 'pending' &&
    current.recovery?.pending !== true &&
    current.lifecycle_uncertain !== true &&
    current.pending !== true &&
    current.close_state !== 'closing' &&
    current.close_state !== 'closed'
  );
}
