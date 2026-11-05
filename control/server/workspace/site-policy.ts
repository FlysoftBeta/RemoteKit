import { RemoteKitError } from '../../shared/errors';
import type { AppliedMediaPolicy } from '../../shared/product';

import type { ProductWorkspace } from '../../shared/product';
import type { DomainContext } from '../application';

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
    if (result?.accepted !== true) throw new RemoteKitError('rejected', 'Endpoint未接受媒体质量策略');
    runtime.policy.media = { encoded, applied: result.applied === true, browserPid };
  }
  async applySites(tenant: string, state: ProductWorkspace, force = false, browserPid?: number) {
    const runtime = this.context.tenants.get(tenant);
    const sites = Object.fromEntries(
      Object.keys(state.sites)
        .sort()
        .filter((origin) => state.sites[origin].tabletUa)
        .map((origin) => [origin, { tabletUa: true }]),
    );
    const encoded = JSON.stringify(sites),
      previous = runtime.policy.site;
    if (!force && previous?.encoded === encoded && previous.applied) return;
    runtime.policy.site = { encoded, applied: false, browserPid };
    const result = await this.context.endpoint.sitePreferences(tenant, { sites });
    if (result?.accepted !== true) throw new RemoteKitError('rejected', 'Endpoint未接受站点身份设置');
    runtime.policy.site = { encoded, applied: result.applied === true, browserPid };
  }
}
