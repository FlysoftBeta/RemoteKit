import { RemoteKitError } from '../../shared/errors';
import { SITE_PERMISSIONS, type AppliedMediaPolicy, type SitePreferences } from '../../shared/product';

import type { ProductWorkspace } from '../../shared/product';
import type { DomainContext } from '../application';
import type { SessionSitePreferencesRequest } from '../endpoint/types';

export function validSiteOrigin(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && url.origin === value;
  } catch {
    return false;
  }
}
const protocolSafelist = new Set(
  'bitcoin cabal dat did dweb ethereum ftp ftps geo im ipfs ipns irc ircs magnet mailto matrix mms news nntp openpgp4fpr sftp sip sms smsto ssb ssh tel urn webcal wtai xmpp'.split(
    ' ',
  ),
);
export function validProtocol(value: unknown): value is string {
  return typeof value === 'string' && (protocolSafelist.has(value) || /^web\+[a-z]+$/.test(value));
}
export function validProtocolHandler(origin: string, protocol: unknown, value: unknown): value is string {
  if (
    !validSiteOrigin(origin) ||
    !validProtocol(protocol) ||
    typeof value !== 'string' ||
    value.length > 2048 ||
    !value.includes('%s')
  )
    return false;
  try {
    const url = new URL(value);
    return (
      url.origin === origin &&
      (url.protocol === 'https:' ||
        (url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))
    );
  } catch {
    return false;
  }
}
export function pruneSite(state: ProductWorkspace, origin: string) {
  const site = state.sites[origin];
  if (!site) return;
  if (!site.tabletUa) delete site.tabletUa;
  if (!Object.keys(site.permissions ?? {}).length) delete site.permissions;
  if (!site.protocolHandlers?.length) delete site.protocolHandlers;
  if (!Object.keys(site).length) delete state.sites[origin];
}
export function ensureSite(state: ProductWorkspace, origin: string): SitePreferences {
  if (!state.sites[origin] && Object.keys(state.sites).length >= 4096)
    throw new RemoteKitError('limit_exceeded', '站点设置已达上限', { capacity: 'site-settings' });
  return (state.sites[origin] ??= {});
}
export function sitePayload(state: ProductWorkspace): SessionSitePreferencesRequest['sites'] {
  return Object.fromEntries(
    Object.keys(state.sites)
      .sort()
      .flatMap((origin) => {
        const site = state.sites[origin];
        const permissions = Object.fromEntries(
          SITE_PERMISSIONS.flatMap((permission) =>
            site.permissions?.[permission] ? [[permission, site.permissions[permission]]] : [],
          ),
        );
        const value = {
          ...(site.tabletUa ? { tabletUa: true as const } : {}),
          ...(Object.keys(permissions).length ? { permissions } : {}),
          ...(site.protocolHandlers?.length ? { protocolHandlers: site.protocolHandlers } : {}),
        };
        return Object.keys(value).length ? [[origin, value]] : [];
      }),
  );
}

export class SitePolicy {
  reset(tenant: string) {
    this.context.tenants.get(tenant).policy = {};
  }
  observeMedia(tenant: string, applied: AppliedMediaPolicy | null | undefined) {
    const policy = this.context.tenants.get(tenant).policy;
    if (applied === null) delete policy.actualMedia;
    else if (applied) policy.actualMedia = applied;
  }

  constructor(private readonly context: DomainContext) {}
  qualityState(tenant: string) {
    return this.context.tenants.get(tenant).quality;
  }
  qualityFor(tenant: string, workspace = this.context.store.workspaces.workspace(tenant)) {
    const runtime = this.context.tenants.get(tenant);
    return this.qualityState(tenant).snapshot(
      workspace,
      runtime.viewer?.viewport ?? runtime.lastViewport,
      this.context.clock.wallMs(),
      runtime.policy.actualMedia ?? null,
    );
  }
}
