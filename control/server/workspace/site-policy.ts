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
    throw new RemoteKitError('limit_exceeded', '站点设置已达上限');
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
  configuration(tenant: string, key: string) {
    return this.context.tenants.get(tenant).policy.configurations.get(key);
  }
  appliedConfiguration(tenant: string, key: string, encoded: string) {
    this.context.tenants.get(tenant).policy.configurations.set(key, encoded);
  }
  invalidateConfiguration(tenant: string, key: string) {
    this.context.tenants.get(tenant).policy.configurations.delete(key);
  }

  reset(tenant: string) {
    this.context.tenants.get(tenant).policy = { configurations: new Map() };
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
  async applyMedia(tenant: string, force = false, browserPid?: number) {
    const runtime = this.context.tenants.get(tenant);
    const requested = this.qualityFor(tenant).requested,
      encoded = JSON.stringify(requested),
      previous = runtime.policy.media;
    if (!force && previous?.encoded === encoded && previous.applied) return;
    runtime.policy.media = { encoded, applied: false, browserPid };
    const result = await this.context.endpoint.mediaPolicy(tenant, requested);
    if (result?.accepted !== true) throw new RemoteKitError('outcome_unknown', 'Endpoint未接受媒体质量策略');
    runtime.policy.media = { encoded, applied: result.applied === true, browserPid };
  }
  async applySites(tenant: string, state: ProductWorkspace, force = false, browserPid?: number) {
    const runtime = this.context.tenants.get(tenant);
    const sites = sitePayload(state);
    const encoded = JSON.stringify(sites),
      previous = runtime.policy.site;
    if (!force && previous?.encoded === encoded && previous.applied) return;
    runtime.policy.site = { encoded, applied: false, browserPid };
    const result = await this.context.endpoint.sitePreferences(tenant, { sites });
    if (result?.accepted !== true) throw new RemoteKitError('outcome_unknown', 'Endpoint未接受站点身份设置');
    runtime.policy.site = { encoded, applied: result.applied === true, browserPid };
  }
}
