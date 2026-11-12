import { randomUUID } from 'node:crypto';
import type { AdminAnnouncement } from '../../shared/admin';
import { RemoteKitError } from '../../shared/errors';
import { ANNOUNCEMENT_LIMITS } from '../../shared/product';
import type { DomainContext, DomainServices } from '../application';

function text(value: unknown, limit: number, name: string) {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (!trimmed) throw new RemoteKitError('invalid_request', `请填写${name}`);
  if (trimmed.length > limit)
    throw new RemoteKitError('limit_exceeded', `${name}不能超过 ${limit} 个字`, { capacity: 'field' });
  return trimmed;
}

/** Announcements are global; every user reads them through their own ProductState. */
export class Announcements {
  constructor(
    private readonly context: DomainContext,
    private readonly services: Pick<DomainServices, 'viewers'>,
  ) {}
  list(): AdminAnnouncement[] {
    const recipients = this.context.store.accounts.users().filter((user) => user.disabledAt === null).length;
    return this.context.store.announcements.list().map((item) => ({ ...item, recipients }));
  }
  // The publishing administrator has read what they wrote.
  publish(actor: string, title: unknown, body: unknown) {
    const draft = this.draft(title, body);
    const id = randomUUID();
    this.context.store.transaction(() => {
      this.context.store.announcements.insert(id, draft.title, draft.body, this.context.clock.wallMs());
      this.context.store.announcements.markRead(id, this.userId(actor));
    });
    return this.changed();
  }
  update(actor: string, id: unknown, title: unknown, body: unknown, republish: unknown) {
    const draft = this.draft(title, body);
    if (typeof republish !== 'boolean') throw new RemoteKitError('invalid_request', '无效的重新提醒选项');
    this.context.store.transaction(() => {
      this.assertExists(id);
      this.context.store.announcements.update(
        id,
        draft.title,
        draft.body,
        this.context.clock.wallMs(),
        republish,
      );
      if (republish) this.context.store.announcements.markRead(id, this.userId(actor));
    });
    return this.changed();
  }
  delete(id: unknown) {
    this.context.store.transaction(() => {
      this.assertExists(id);
      this.context.store.announcements.delete(id);
    });
    return this.changed();
  }
  markRead(tenant: string, id: unknown) {
    const read = this.context.store.transaction(() => {
      this.assertExists(id);
      return this.context.store.announcements.markRead(id, this.userId(tenant));
    });
    if (read) this.services.viewers.push(tenant);
    return { read: true };
  }
  private userId(tenant: string) {
    return this.context.store.accounts.userForTenant(tenant)!.id;
  }
  private assertExists(id: unknown): asserts id is string {
    if (typeof id !== 'string' || !this.context.store.announcements.exists(id))
      throw new RemoteKitError('not_found', '公告不存在');
  }
  private draft(title: unknown, body: unknown) {
    return {
      title: text(title, ANNOUNCEMENT_LIMITS.title, '标题'),
      body: text(body, ANNOUNCEMENT_LIMITS.body, '内容'),
    };
  }
  private changed() {
    for (const [tenant] of this.context.tenants.withViewers()) this.services.viewers.push(tenant);
    return this.list();
  }
}
