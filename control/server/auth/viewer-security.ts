import type { ServicePeers } from '../viewers/service-peers';
import { log, reportError } from '../log';
import { wireError } from '../../shared/errors';
import { endpointError } from '../endpoint/gateway';
import { randomUUID } from 'node:crypto';
import { RemoteKitError } from '../../shared/errors';
import type { AuthSettings, AuthState, FacePurpose, FaceStatus } from '../../shared/security';
import type { EndpointGateway } from '../endpoint/gateway';
import type { ControlDatabase } from '../persistence/database';
import { systemClock, type Clock } from '../util/clock';
import { hashSecret } from './crypto';
import { validFaceTemplate } from '../persistence/sealed-documents';

// Endpoint gate epochs are scoped to a peer and restart on its replacement.
interface Peer {
  connectionId: string;
  epoch: number;
  appliedEpoch: number;
  requests: number;
}
interface Challenge {
  id: string;
  peer: Peer;
  epoch: number;
  purpose: FacePurpose;
  expires: number;
  modelVersion: string;
  started: boolean;
}
export type ViewerLock =
  | { state: 'locked'; epoch: number }
  | { state: 'unlocking'; epoch: number }
  | { state: 'unlocked'; epoch: number };
export function transitionLock(viewer: ViewerSecurityState, state: ViewerLock['state'], advance = true) {
  viewer.lock = { state, epoch: viewer.lock.epoch + (advance ? 1 : 0) };
}
export interface ViewerSecurityState {
  user: AuthState['user'];
  lock: ViewerLock;
  readonly locked: boolean;
  // Public epoch is scoped to this Viewer lease and guards asynchronous work.
  readonly epoch: number;
  peer?: Peer;
  servicePeer?: Peer;
  challenge?: Challenge;
  face: Omit<AuthState['face'], 'enrolled'> & { modelVersion?: string };
  polling: boolean;
  mutating: boolean;
}

export class ViewerSecurity {
  private readonly revocations = new Map<ViewerSecurityState, string>();
  constructor(
    private readonly store: ControlDatabase,
    private readonly endpoint: EndpointGateway,
    private readonly service: ServicePeers,
    private readonly changed: (tenant: string, viewer: ViewerSecurityState, workspace: boolean) => void,
    private readonly valid: (tenant: string, viewer: ViewerSecurityState) => boolean,
    private readonly locked: (tenant: string, viewer: ViewerSecurityState) => void,
    private readonly clock: Clock = systemClock,
  ) {}

  create(user: AuthState['user'], unlocked: boolean): ViewerSecurityState {
    return {
      user,
      lock: { state: unlocked ? 'unlocked' : 'locked', epoch: 1 },
      get locked() {
        return this.lock.state !== 'unlocked';
      },
      get epoch() {
        return this.lock.epoch;
      },
      face: { available: false },
      polling: false,
      mutating: false,
    };
  }

  state(viewer: ViewerSecurityState, endpointGeneration: number): AuthState {
    const { settings, pin, face } = this.store.security.security(viewer.user.id);
    const { modelVersion, ...status } = viewer.face;
    return {
      user: viewer.user,
      locked: viewer.locked,
      epoch: viewer.epoch,
      peerEpoch: viewer.peer?.appliedEpoch ?? 0,
      serviceEpoch: viewer.servicePeer?.appliedEpoch ?? 0,
      settings,
      methods: {
        password: true,
        pin: !!pin,
        face: !!face && settings.faceEnabled && status.available && face.modelVersion === modelVersion,
      },
      face: { ...status, enrolled: !!face },
      endpointGeneration,
    };
  }

  private check(tenant: string, viewer: ViewerSecurityState, epoch: number, locked?: boolean) {
    if (
      !this.valid(tenant, viewer) ||
      viewer.epoch !== epoch ||
      (locked !== undefined && viewer.locked !== locked)
    )
      throw new RemoteKitError('conflict', '验证状态已改变');
  }

  async capabilities(tenant: string, viewer: ViewerSecurityState) {
    const peer = viewer.servicePeer;
    const result = await this.service.faceCapabilities(tenant).catch(() => undefined);
    if (!this.valid(tenant, viewer) || viewer.servicePeer !== peer) return;
    const available =
      result?.available === true &&
      typeof result.modelVersion === 'string' &&
      result.modelVersion.length > 0 &&
      result.modelVersion.length <= 128;
    viewer.face = {
      ...viewer.face,
      available,
      modelVersion: available ? result.modelVersion : undefined,
      reason: available
        ? viewer.face.available
          ? viewer.face.reason
          : undefined
        : '文件和人脸服务暂无可用节点',
    };
    this.changed(tenant, viewer, false);
  }

  forgetPeer(tenant: string, viewer: ViewerSecurityState) {
    viewer.peer = undefined;
  }

  forgetServicePeer(tenant: string, viewer: ViewerSecurityState) {
    this.clearChallenge(tenant, viewer, false, false);
    viewer.servicePeer = undefined;
    viewer.face = { available: false, reason: '文件和人脸服务暂无可用节点' };
  }

  async revokePeer(tenant: string, viewer: ViewerSecurityState) {
    this.revocations.set(viewer, tenant);
    try {
      await this.lock(tenant, viewer);
      this.forgetPeer(tenant, viewer);
      this.revocations.delete(viewer);
    } catch (err) {
      log.error('security.revoke_failed', { tenant, connectionId: viewer.peer?.connectionId, err });
    }
  }

  retiring(tenant: string, connectionId: string | null) {
    return [...this.revocations].find(
      ([viewer, owner]) =>
        owner === tenant &&
        !!viewer.peer &&
        (connectionId === null || viewer.peer.connectionId === connectionId),
    )?.[0];
  }
  async retryRevocations() {
    await Promise.all(
      [...this.revocations].map(async ([viewer, tenant]) => {
        if (viewer.peer?.requests) return;
        try {
          await this.apply(tenant, viewer, false);
          this.forgetPeer(tenant, viewer);
          this.revocations.delete(viewer);
        } catch (err) {
          log.error('security.revoke_failed', { tenant, connectionId: viewer.peer?.connectionId, err });
        }
      }),
    );
  }

  async bind(tenant: string, viewer: ViewerSecurityState, connectionId: string) {
    this.forgetPeer(tenant, viewer);
    viewer.peer = { connectionId, epoch: 0, appliedEpoch: 0, requests: 0 };
    try {
      await this.apply(tenant, viewer, !viewer.locked);
    } catch (error) {
      if (this.valid(tenant, viewer) && viewer.locked && viewer.peer?.epoch > 1) {
        await this.apply(tenant, viewer, false);
        void this.capabilities(tenant, viewer);
        return;
      }
      throw error;
    }
    void this.capabilities(tenant, viewer);
  }

  async restore(tenant: string, viewer: ViewerSecurityState) {
    if (viewer.peer) await this.apply(tenant, viewer, !viewer.locked);
    void this.capabilities(tenant, viewer);
  }

  private async apply(tenant: string, viewer: ViewerSecurityState, unlocked: boolean) {
    const peer = viewer.peer;
    if (!peer) return;
    const { connectionId } = peer;
    const epoch = ++peer.epoch;
    peer.requests++;
    peer.appliedEpoch = 0;
    try {
      const desired = await this.endpoint.synchronize(tenant);
      const observed = await this.endpoint.waitObserved(
        tenant,
        (value) =>
          (value.authorization.connectionId === connectionId &&
            value.authorization.epoch >= epoch &&
            (value.authorization.epoch !== epoch || value.authorization.unlocked === unlocked)) ||
          (BigInt(value.observedRevision) >= BigInt(desired.revision) && value.lastError !== null),
      );
      if (
        observed.lastError &&
        (observed.authorization.connectionId !== connectionId ||
          observed.authorization.epoch !== epoch ||
          observed.authorization.unlocked !== unlocked)
      )
        throw new RemoteKitError('unavailable', observed.lastError.message);
      const result = { applied: true, epoch: observed.authorization.epoch };
      if (result?.applied !== true || result.epoch !== epoch || viewer.peer !== peer || peer.epoch !== epoch)
        throw new RemoteKitError('outcome_unknown', 'Endpoint 授权结果未知');
      peer.appliedEpoch = epoch;
      this.changed(tenant, viewer, false);
    } catch (err) {
      if (!unlocked) log.error('security.lock_failed', { tenant, connectionId, epoch, err });
      throw err;
    } finally {
      peer.requests--;
    }
  }

  async lock(tenant: string, viewer: ViewerSecurityState, preserveFace = false, send = true) {
    transitionLock(viewer, 'locked');
    this.clearChallenge(tenant, viewer, preserveFace, send);
    this.changed(tenant, viewer, false);
    if (!send && viewer.peer) viewer.peer.appliedEpoch = 0;
    const applied = send ? this.apply(tenant, viewer, false) : Promise.resolve();
    this.locked(tenant, viewer);
    await applied;
  }

  private async unlock(tenant: string, viewer: ViewerSecurityState, epoch: number) {
    this.check(tenant, viewer, epoch, true);
    this.clearChallenge(tenant, viewer, true);
    transitionLock(viewer, 'unlocked');
    this.changed(tenant, viewer, true);
    void this.apply(tenant, viewer, true).catch((err) =>
      log.warn('security.authorize_failed', { tenant, err }),
    );
  }

  private clearChallenge(tenant: string, viewer: ViewerSecurityState, preserve = false, send = true) {
    const challenge = viewer.challenge;
    viewer.challenge = undefined;
    if (!preserve) {
      delete viewer.face.challengeId;
      delete viewer.face.purpose;
      delete viewer.face.status;
      if (viewer.face.available) delete viewer.face.reason;
    }
    if (challenge && send)
      void this.service
        .cancelFace(tenant, this.faceBinding(challenge))
        .catch((err) => log.warn('security.cancel_face_failed', { tenant, challengeId: challenge.id, err }));
  }

  private faceBinding(challenge: Challenge) {
    return { connectionId: challenge.peer.connectionId, epoch: challenge.epoch, challengeId: challenge.id };
  }

  private async startFace(
    tenant: string,
    viewer: ViewerSecurityState,
    purpose: FacePurpose,
    generation: number,
  ) {
    const peer = viewer.servicePeer,
      modelVersion = viewer.face.modelVersion;
    const record = this.store.security.security(viewer.user.id);
    if (!peer || peer.appliedEpoch !== peer.epoch || !viewer.face.available || !modelVersion)
      throw new RemoteKitError('unavailable', '人脸验证通道尚未就绪');
    if (
      purpose !== 'enroll' &&
      (!record.settings.faceEnabled || !record.face || record.face.modelVersion !== modelVersion)
    )
      throw new RemoteKitError('conflict', '请先录入当前模型的人脸');
    if ((purpose === 'enroll' && viewer.locked) || (purpose === 'verify' && !viewer.locked))
      throw new RemoteKitError('locked', '当前锁屏状态不支持此请求');
    if (purpose === 'presence' && !viewer.locked && !record.settings.lockOnDeparture)
      throw new RemoteKitError('conflict', '未启用离开锁定');
    if (viewer.challenge?.purpose === purpose) return;
    let template: number[] | undefined;
    if (purpose !== 'enroll') {
      try {
        template = this.store.security.faceVault.open(viewer.user.id, record.face!.sealed, modelVersion);
      } catch {
        throw new RemoteKitError('conflict', '已录入的人脸不可用，请用密码重新录入');
      }
    }
    this.clearChallenge(tenant, viewer);
    const timeoutMs = purpose === 'enroll' ? 60000 : purpose === 'verify' ? 30000 : 120000;
    const challenge: Challenge = {
      id: randomUUID(),
      peer,
      epoch: peer.epoch,
      purpose,
      expires: this.clock.monotonicMs() + timeoutMs,
      modelVersion,
      started: false,
    };
    viewer.challenge = challenge;
    try {
      const result = await this.service.beginFace(tenant, {
        ...this.faceBinding(challenge),
        purpose,
        timeoutMs,
        ...(template ? { template } : {}),
      });
      this.check(tenant, viewer, generation);
      if (
        peer.epoch !== challenge.epoch ||
        peer.appliedEpoch !== challenge.epoch ||
        viewer.challenge !== challenge ||
        result?.accepted !== true
      )
        throw new RemoteKitError('outcome_unknown', '人脸请求结果未知');
      challenge.started = true;
      viewer.face = { ...viewer.face, challengeId: challenge.id, purpose, status: 'pending' };
      this.changed(tenant, viewer, false);
    } catch (error) {
      if (viewer.challenge === challenge) this.clearChallenge(tenant, viewer);
      throw error;
    }
  }

  async poll(tenant: string, viewer: ViewerSecurityState) {
    const peer = viewer.peer;
    if (peer && peer.appliedEpoch !== peer.epoch && peer.requests === 0 && this.valid(tenant, viewer))
      await this.apply(tenant, viewer, !viewer.locked).catch((err) =>
        log.error('security.reapply_failed', { tenant, err }),
      );
    const challenge = viewer.challenge;
    if (!challenge?.started || viewer.polling || !this.valid(tenant, viewer)) return;
    viewer.polling = true;
    const generation = viewer.epoch;
    try {
      const result = await this.service
        .faceStatus(tenant, this.faceBinding(challenge))
        .catch((error: unknown) => {
          log.warn('security.face_status_failed', { tenant, challengeId: challenge.id, err: error });
          return {
            challengeId: challenge.id,
            status: 'failed',
            error: wireError(
              reportError(endpointError(error), 'security.face_failed', { tenant, operation: challenge.id }),
            ),
            outcome: undefined,
            template: undefined,
          };
        });
      if (
        !this.valid(tenant, viewer) ||
        viewer.epoch !== generation ||
        viewer.challenge !== challenge ||
        viewer.servicePeer !== challenge.peer ||
        challenge.peer.appliedEpoch !== challenge.epoch
      )
        return;
      let status: FaceStatus =
        result?.challengeId === challenge.id &&
        ['pending', 'matched', 'enrolled', 'absent', 'failed', 'expired'].includes(result.status)
          ? (result.status as FaceStatus)
          : 'failed';
      if (this.clock.monotonicMs() >= challenge.expires) status = 'expired';
      if (
        (status === 'enrolled' && challenge.purpose !== 'enroll') ||
        (status === 'matched' && challenge.purpose === 'enroll') ||
        (status === 'absent' && challenge.purpose !== 'presence')
      )
        status = 'failed';
      if (status === 'pending' || (challenge.purpose === 'presence' && status === 'matched')) return;
      if (challenge.purpose === 'enroll' && status === 'enrolled') {
        if (viewer.locked || !validFaceTemplate(result?.template)) status = 'failed';
        else {
          const record = this.store.security.security(viewer.user.id);
          try {
            record.face = {
              sealed: this.store.security.faceVault.seal(
                viewer.user.id,
                result!.template!,
                challenge.modelVersion,
              ),
              modelVersion: challenge.modelVersion,
            };
            record.settings.faceEnabled = true;
            this.store.security.saveSecurity(viewer.user.id, record);
          } catch (err) {
            log.warn('security.save_face_failed', { tenant, err });
            status = 'failed';
          }
        }
      }
      viewer.face.status = status;
      if (status === 'absent') viewer.face.outcome = result?.outcome;
      else delete viewer.face.outcome;
      if (status === 'failed')
        viewer.face.error = wireError(
          reportError(
            result?.error ? endpointError(result.error) : new RemoteKitError('internal', '人脸验证失败'),
            'security.face_failed',
            { tenant, operation: challenge.id },
          ),
        );
      else delete viewer.face.error;
      this.clearChallenge(tenant, viewer, true);
      this.changed(tenant, viewer, false);
      if (challenge.purpose === 'verify' && status === 'matched')
        await this.unlock(tenant, viewer, generation);
      if (challenge.purpose === 'presence') {
        if (status === 'expired' && !viewer.locked)
          await this.startFace(tenant, viewer, 'presence', generation);
        else if (status !== 'expired' && !viewer.locked) await this.lock(tenant, viewer, true);
      }
    } catch (err) {
      log.warn('security.face_poll_failed', { tenant, challengeId: challenge.id, err });
      if (
        challenge.purpose === 'presence' &&
        !viewer.locked &&
        this.valid(tenant, viewer) &&
        viewer.epoch === generation
      )
        await this.lock(tenant, viewer, true).catch((err) =>
          log.error('security.lock_failed', { tenant, err }),
        );
    } finally {
      viewer.polling = false;
    }
  }

  async request(
    tenant: string,
    viewer: ViewerSecurityState,
    method: string,
    params: Record<string, unknown>,
  ) {
    if (method === 'auth.get') return;
    if (method === 'auth.lock') {
      await this.lock(tenant, viewer);
      return;
    }
    if (method === 'auth.face.cancel') {
      if (typeof params.challengeId !== 'string' || params.challengeId !== viewer.face.challengeId)
        throw new RemoteKitError('conflict', '人脸请求已改变');
      this.clearChallenge(tenant, viewer);
      this.changed(tenant, viewer, false);
      return;
    }
    const generation = viewer.epoch,
      user = viewer.user.id;
    if (viewer.mutating) throw new RemoteKitError('busy', '验证请求仍在处理');
    viewer.mutating = true;
    try {
      if (method === 'auth.verify') {
        if (!viewer.locked) return;
        if (params.method === 'password') await this.store.security.verifyPassword(user, params.secret);
        else if (params.method === 'pin') await this.store.security.verifyPin(user, params.secret);
        else throw new RemoteKitError('invalid_request', '无效验证方式');
        await this.unlock(tenant, viewer, generation);
        return;
      }
      if (method === 'auth.face.begin') {
        const purpose = params.purpose;
        if (purpose !== 'verify' && purpose !== 'enroll' && purpose !== 'presence')
          throw new RemoteKitError('invalid_request', '无效人脸请求');
        if (purpose === 'enroll') {
          this.check(tenant, viewer, generation, false);
          await this.store.security.verifyPassword(user, params.currentPassword);
        }
        this.check(tenant, viewer, generation);
        await this.store.security.authAttempts.run(
          'face:' + user,
          () => this.startFace(tenant, viewer, purpose, generation),
          10,
        );
        return;
      }
      if (!['auth.settings', 'auth.password', 'auth.face.remove'].includes(method))
        throw new RemoteKitError('invalid_request', '未知验证方法');
      this.check(tenant, viewer, generation, false);
      const currentHash = await this.store.security.verifyPassword(user, params.currentPassword);
      const authorize = () => this.check(tenant, viewer, generation, false);
      authorize();
      if (method === 'auth.password')
        await this.store.security.replacePassword(user, currentHash, params.newPassword, authorize);
      else if (method === 'auth.face.remove') {
        const record = this.store.security.security(user);
        record.face = undefined;
        record.settings.faceEnabled = false;
        record.settings.lockOnDeparture = false;
        this.clearChallenge(tenant, viewer);
        this.store.security.saveSecurity(user, record);
      } else {
        const settings = this.validateSettings(params.settings);
        let pin;
        if (params.pin !== undefined && params.pin !== null) {
          if (typeof params.pin !== 'string' || !/^\d{6,12}$/.test(params.pin))
            throw new RemoteKitError('invalid_request', 'PIN 需6–12位数字');
          pin = await hashSecret(params.pin);
        }
        authorize();
        const record = this.store.security.security(user);
        Object.assign(record.settings, settings);
        if (
          (!record.face && record.settings.faceEnabled) ||
          (!record.settings.faceEnabled && record.settings.lockOnDeparture)
        )
          throw new RemoteKitError('conflict', '请先启用已录入的人脸');
        if (params.pin !== undefined) record.pin = pin;
        if (
          !record.settings.faceEnabled ||
          (!record.settings.lockOnDeparture && viewer.challenge?.purpose === 'presence')
        )
          this.clearChallenge(tenant, viewer);
        this.store.security.saveSecurity(user, record);
      }
      this.changed(tenant, viewer, false);
    } finally {
      viewer.mutating = false;
    }
  }

  private validateSettings(value: unknown): Partial<AuthSettings> {
    if (value === undefined) return {};
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new RemoteKitError('invalid_request', '锁定设置无效');
    for (const [key, item] of Object.entries(value)) {
      if (key === 'idleSeconds' && Number.isInteger(item) && item >= 15 && item <= 3600) continue;
      if (
        ['lockOnHidden', 'lockOnIdle', 'lockOnDeparture', 'faceEnabled'].includes(key) &&
        typeof item === 'boolean'
      )
        continue;
      throw new RemoteKitError('invalid_request', '锁定设置无效');
    }
    return value;
  }
}
