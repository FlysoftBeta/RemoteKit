import { randomUUID } from 'node:crypto';
import type { AuthSettings, AuthState, FacePurpose, FaceStatus } from '../shared/security';
import type { Endpoint } from './endpoint';
import type { Store } from './store';
import { AuthError, hashSecret, validFaceTemplate } from './security-crypto';

// Endpoint gate epochs are scoped to a peer and restart on its replacement.
interface Peer { connectionId: string; epoch: number; appliedEpoch: number; requests: number }
interface Challenge {
  id: string;
  peer: Peer;
  epoch: number;
  purpose: FacePurpose;
  expires: number;
  modelVersion: string;
  started: boolean;
}
export interface ViewerSecurity {
  user: AuthState['user'];
  locked: boolean;
  // Public epoch is scoped to this Viewer lease and guards asynchronous work.
  epoch: number;
  peer?: Peer;
  challenge?: Challenge;
  face: Omit<AuthState['face'], 'enrolled'> & { modelVersion?: string };
  polling: boolean;
  mutating: boolean;
}

export class ViewerAuth {
  constructor(private readonly store: Store, private readonly endpoint: Endpoint,
    private readonly changed: (tenant: string, viewer: ViewerSecurity, workspace: boolean) => void,
    private readonly valid: (tenant: string, viewer: ViewerSecurity) => boolean,
    private readonly locked: (tenant: string, viewer: ViewerSecurity) => void) {}

  create(user: AuthState['user'], unlocked: boolean): ViewerSecurity {
    return { user, locked: !unlocked, epoch: 1, face: { available: false }, polling: false, mutating: false };
  }

  state(viewer: ViewerSecurity, trickleIce: boolean, endpointGeneration: number): AuthState {
    const { settings, pin, face } = this.store.security(viewer.user.id);
    const { modelVersion, ...status } = viewer.face;
    return { user: viewer.user, locked: viewer.locked, epoch: viewer.epoch, peerEpoch: viewer.peer?.appliedEpoch ?? 0, settings,
      methods: { password: true, pin: !!pin, face: !!face && settings.faceEnabled && status.available && face.modelVersion === modelVersion },
      face: { ...status, enrolled: !!face }, trickleIce, endpointGeneration };
  }

  private check(tenant: string, viewer: ViewerSecurity, epoch: number, locked?: boolean) {
    if (!this.valid(tenant, viewer) || viewer.epoch !== epoch || (locked !== undefined && viewer.locked !== locked)) throw new AuthError(409, '验证状态已改变');
  }

  async capabilities(tenant: string, viewer: ViewerSecurity) {
    const peer = viewer.peer;
    const result = await this.endpoint.request('auth.face.capabilities', tenant).catch(() => undefined);
    if (!this.valid(tenant, viewer) || viewer.peer !== peer) return;
    const available = result?.available === true && typeof result.modelVersion === 'string' && result.modelVersion.length > 0 && result.modelVersion.length <= 128;
    viewer.face = { ...viewer.face, available, modelVersion: available ? result.modelVersion : undefined,
      reason: available ? (viewer.face.available ? viewer.face.reason : undefined) : 'Endpoint 人脸模型不可用' };
    this.changed(tenant, viewer, false);
  }

  forgetPeer(tenant: string, viewer: ViewerSecurity) {
    this.clearChallenge(tenant, viewer);
    viewer.peer = undefined;
    viewer.face = { available: false };
  }

  async bind(tenant: string, viewer: ViewerSecurity, connectionId: string) {
    this.forgetPeer(tenant, viewer);
    viewer.peer = { connectionId, epoch: 0, appliedEpoch: 0, requests: 0 };
    try { await this.apply(tenant, viewer, !viewer.locked); }
    catch (error) {
      if (this.valid(tenant, viewer) && viewer.locked && viewer.peer?.epoch > 1) {
        await this.apply(tenant, viewer, false);
        void this.capabilities(tenant, viewer);
        return;
      }
      if (!viewer.locked) {
        viewer.locked = true;
        viewer.epoch++;
        this.changed(tenant, viewer, false);
        this.locked(tenant, viewer);
      }
      throw error;
    }
    void this.capabilities(tenant, viewer);
  }

  async restore(tenant: string, viewer: ViewerSecurity) {
    if (viewer.peer) await this.apply(tenant, viewer, !viewer.locked);
    void this.capabilities(tenant, viewer);
  }

  private async apply(tenant: string, viewer: ViewerSecurity, unlocked: boolean) {
    const peer = viewer.peer;
    if (!peer) return;
    const { connectionId } = peer;
    const epoch = ++peer.epoch;
    peer.requests++;
    try {
      const result = await this.endpoint.request('rtc.authorize', tenant, { connectionId, epoch, unlocked });
      if (result?.applied !== true || result.epoch !== epoch || viewer.peer !== peer || peer.epoch !== epoch) throw new AuthError(409, 'Endpoint 授权已改变');
      peer.appliedEpoch = epoch;
      this.changed(tenant, viewer, false);
    } finally { peer.requests--; }
  }

  async lock(tenant: string, viewer: ViewerSecurity, preserveFace = false, send = true) {
    viewer.locked = true;
    viewer.epoch++;
    this.clearChallenge(tenant, viewer, preserveFace, send);
    this.changed(tenant, viewer, false);
    if (!send && viewer.peer) viewer.peer.appliedEpoch = 0;
    const applied = send ? this.apply(tenant, viewer, false) : Promise.resolve();
    this.locked(tenant, viewer);
    await applied;
  }

  private async unlock(tenant: string, viewer: ViewerSecurity, epoch: number) {
    this.check(tenant, viewer, epoch, true);
    this.clearChallenge(tenant, viewer, true);
    try { await this.apply(tenant, viewer, true); }
    catch (error) {
      if (this.valid(tenant, viewer) && viewer.epoch === epoch) await this.lock(tenant, viewer).catch(() => {});
      throw error;
    }
    this.check(tenant, viewer, epoch, true);
    viewer.locked = false;
    viewer.epoch++;
    this.changed(tenant, viewer, true);
  }

  private clearChallenge(tenant: string, viewer: ViewerSecurity, preserve = false, send = true) {
    const challenge = viewer.challenge;
    viewer.challenge = undefined;
    if (!preserve) {
      delete viewer.face.challengeId;
      delete viewer.face.purpose;
      delete viewer.face.status;
      if (viewer.face.available) delete viewer.face.reason;
    }
    if (challenge && send) void this.endpoint.request('auth.face.cancel', tenant, this.faceBinding(challenge)).catch(() => {});
  }

  private faceBinding(challenge: Challenge) {
    return { connectionId: challenge.peer.connectionId, epoch: challenge.epoch, challengeId: challenge.id };
  }

  private async startFace(tenant: string, viewer: ViewerSecurity, purpose: FacePurpose, generation: number) {
    const peer = viewer.peer, modelVersion = viewer.face.modelVersion;
    const record = this.store.security(viewer.user.id);
    if (!peer || peer.appliedEpoch !== peer.epoch || !viewer.face.available || !modelVersion) throw new AuthError(409, '人脸验证通道尚未就绪');
    if (purpose !== 'enroll' && (!record.settings.faceEnabled || !record.face || record.face.modelVersion !== modelVersion)) throw new AuthError(409, '请先录入当前模型的人脸');
    if (purpose === 'enroll' && viewer.locked || purpose === 'verify' && !viewer.locked) throw new AuthError(423, '当前锁屏状态不支持此请求');
    if (purpose === 'presence' && !viewer.locked && !record.settings.lockOnDeparture) throw new AuthError(409, '未启用离开锁定');
    if (viewer.challenge?.purpose === purpose) return;
    let template: number[] | undefined;
    if (purpose !== 'enroll') {
      try { template = this.store.faceVault.open(viewer.user.id, record.face!.sealed, modelVersion); }
      catch { throw new AuthError(409, '已录入的人脸不可用，请用密码重新录入'); }
    }
    this.clearChallenge(tenant, viewer);
    const timeoutMs = purpose === 'enroll' ? 60000 : purpose === 'verify' ? 30000 : 120000;
    const challenge: Challenge = { id: randomUUID(), peer, epoch: peer.epoch, purpose, expires: Date.now() + timeoutMs, modelVersion, started: false };
    viewer.challenge = challenge;
    try {
      const result = await this.endpoint.request('auth.face.begin', tenant, { ...this.faceBinding(challenge), purpose, timeoutMs, ...(template ? { template } : {}) });
      this.check(tenant, viewer, generation);
      if (peer.epoch !== challenge.epoch || peer.appliedEpoch !== challenge.epoch || viewer.challenge !== challenge || result?.accepted !== true) throw new AuthError(409, 'Endpoint 未接受人脸请求');
      challenge.started = true;
      viewer.face = { ...viewer.face, challengeId: challenge.id, purpose, status: 'pending' };
      this.changed(tenant, viewer, false);
    } catch (error) {
      if (viewer.challenge === challenge) this.clearChallenge(tenant, viewer);
      throw error;
    }
  }

  async poll(tenant: string, viewer: ViewerSecurity) {
    const peer = viewer.peer;
    if (viewer.locked && peer && peer.appliedEpoch !== peer.epoch && peer.requests === 0 && this.valid(tenant, viewer))
      await this.apply(tenant, viewer, false).catch(() => {});
    const challenge = viewer.challenge;
    if (!challenge?.started || viewer.polling || !this.valid(tenant, viewer)) return;
    viewer.polling = true;
    const generation = viewer.epoch;
    try {
      const result = await this.endpoint.request('auth.face.status', tenant, this.faceBinding(challenge)).catch(() => undefined);
      if (!this.valid(tenant, viewer) || viewer.epoch !== generation || viewer.challenge !== challenge ||
          viewer.peer !== challenge.peer || challenge.peer.appliedEpoch !== challenge.epoch) return;
      let status: FaceStatus = result?.challengeId === challenge.id &&
        ['pending', 'matched', 'enrolled', 'absent', 'failed', 'expired'].includes(result.status) ? result.status : 'failed';
      if (Date.now() >= challenge.expires) status = 'expired';
      if (status === 'enrolled' && challenge.purpose !== 'enroll' || status === 'matched' && challenge.purpose === 'enroll' ||
          status === 'absent' && challenge.purpose !== 'presence') status = 'failed';
      if (status === 'pending' || (challenge.purpose === 'presence' && status === 'matched')) return;
      if (challenge.purpose === 'enroll' && status === 'enrolled') {
        if (viewer.locked || !validFaceTemplate(result.template)) status = 'failed';
        else {
          const record = this.store.security(viewer.user.id);
          try {
            record.face = { sealed: this.store.faceVault.seal(viewer.user.id, result.template, challenge.modelVersion), modelVersion: challenge.modelVersion };
            record.settings.faceEnabled = true;
            this.store.saveSecurity(viewer.user.id, record);
          } catch { status = 'failed'; }
        }
      }
      viewer.face.status = status;
      const reason = result?.reason;
      if (status === 'absent' && (reason === 'camera-unavailable' || reason === 'no-matching-face')) viewer.face.reason = reason;
      else if (viewer.face.available) delete viewer.face.reason;
      this.clearChallenge(tenant, viewer, true);
      this.changed(tenant, viewer, false);
      if (challenge.purpose === 'verify' && status === 'matched') await this.unlock(tenant, viewer, generation);
      if (challenge.purpose === 'presence') {
        if (status === 'expired' && !viewer.locked) await this.startFace(tenant, viewer, 'presence', generation);
        else if (status !== 'expired' && !viewer.locked) await this.lock(tenant, viewer, true);
      }
    } catch {
      if (challenge.purpose === 'presence' && !viewer.locked && this.valid(tenant, viewer) && viewer.epoch === generation)
        await this.lock(tenant, viewer, true).catch(() => {});
    } finally { viewer.polling = false; }
  }

  async request(tenant: string, viewer: ViewerSecurity, method: string, params: Record<string, unknown>) {
    if (method === 'auth.get') return;
    if (method === 'auth.lock') { await this.lock(tenant, viewer); return; }
    if (method === 'auth.face.cancel') {
      if (typeof params.challengeId !== 'string' || params.challengeId !== viewer.face.challengeId) throw new AuthError(409, '人脸请求已改变');
      this.clearChallenge(tenant, viewer);
      this.changed(tenant, viewer, false);
      return;
    }
    const generation = viewer.epoch, user = viewer.user.id;
    if (viewer.mutating) throw new AuthError(429, '验证请求仍在处理');
    viewer.mutating = true;
    try {
      if (method === 'auth.verify') {
        if (!viewer.locked) return;
        if (params.method === 'password') await this.store.verifyPassword(user, params.secret);
        else if (params.method === 'pin') await this.store.verifyPin(user, params.secret);
        else throw new AuthError(400, '无效验证方式');
        await this.unlock(tenant, viewer, generation);
        return;
      }
      if (method === 'auth.face.begin') {
        const purpose = params.purpose;
        if (purpose !== 'verify' && purpose !== 'enroll' && purpose !== 'presence') throw new AuthError(400, '无效人脸请求');
        if (purpose === 'enroll') {
          this.check(tenant, viewer, generation, false);
          await this.store.verifyPassword(user, params.currentPassword);
        }
        this.check(tenant, viewer, generation);
        await this.store.authAttempts.run('face:' + user, () => this.startFace(tenant, viewer, purpose, generation), 10);
        return;
      }
      if (!['auth.settings', 'auth.password', 'auth.face.remove'].includes(method)) throw new AuthError(400, '未知验证方法');
      this.check(tenant, viewer, generation, false);
      const currentHash = await this.store.verifyPassword(user, params.currentPassword);
      const authorize = () => this.check(tenant, viewer, generation, false);
      authorize();
      if (method === 'auth.password') await this.store.replacePassword(user, currentHash, params.newPassword, authorize);
      else if (method === 'auth.face.remove') {
        const record = this.store.security(user);
        record.face = undefined;
        record.settings.faceEnabled = false;
        record.settings.lockOnDeparture = false;
        this.clearChallenge(tenant, viewer);
        this.store.saveSecurity(user, record);
      } else {
        const settings = this.validateSettings(params.settings);
        let pin;
        if (params.pin !== undefined && params.pin !== null) {
          if (typeof params.pin !== 'string' || !/^\d{6,12}$/.test(params.pin)) throw new AuthError(400, 'PIN 需6–12位数字');
          pin = await hashSecret(params.pin);
        }
        authorize();
        const record = this.store.security(user);
        Object.assign(record.settings, settings);
        if (!record.face && record.settings.faceEnabled || !record.settings.faceEnabled && record.settings.lockOnDeparture) throw new AuthError(409, '请先启用已录入的人脸');
        if (params.pin !== undefined) record.pin = pin;
        if (!record.settings.faceEnabled || (!record.settings.lockOnDeparture && viewer.challenge?.purpose === 'presence')) this.clearChallenge(tenant, viewer);
        this.store.saveSecurity(user, record);
      }
      this.changed(tenant, viewer, false);
    } finally { viewer.mutating = false; }
  }

  private validateSettings(value: unknown): Partial<AuthSettings> {
    if (value === undefined) return {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AuthError(400, '锁定设置无效');
    for (const [key, item] of Object.entries(value)) {
      if (key === 'idleSeconds' && Number.isInteger(item) && item >= 15 && item <= 3600) continue;
      if (['lockOnHidden', 'lockOnIdle', 'lockOnDeparture', 'faceEnabled'].includes(key) && typeof item === 'boolean') continue;
      throw new AuthError(400, '锁定设置无效');
    }
    return value;
  }
}
