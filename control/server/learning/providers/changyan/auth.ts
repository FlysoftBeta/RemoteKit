import { RemoteKitError } from '../../../../shared/errors.js';
import {
  HttpClient,
  type HttpOptions,
  record,
  requiredText,
  number,
  malformed,
  serviceError,
} from '../http.js';
import { AUTH_CONFIG } from './config.js';
import { encryptPassword } from './crypto.js';
import type { ZhixueSession } from './zhixue-auth.js';

export interface SsoSession {
  tgt: string;
  at: string;
  userId: string;
}

export interface ChangyanSession {
  token: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
}

export interface AccountSession {
  displayName?: string;
  sso: SsoSession;
  changyan: ChangyanSession;
  zhixue?: ZhixueSession;
}

export interface CaptchaSeccode {
  captchaOutput: string;
  genTime: string;
  lotNumber: string;
  passToken: string;
}

export interface CaptchaPolicy {
  captchaId: string;
  captchaType: string;
  required: boolean;
  apiServers: string[];
  staticServers: string[];
}

export class AuthClient {
  private readonly http: HttpClient;

  constructor(options: HttpOptions = {}) {
    this.http = new HttpClient(options);
  }

  async captchaPolicy(): Promise<CaptchaPolicy> {
    const data = await this.sso({
      method: 'sso.get.captcha.type',
      ncetAppId: '',
      needCaptchaUrl: 'false',
      ...platformIdentity(),
      ...clientIdentity(),
      ...networkIdentity(true),
    });
    let conf: Record<string, unknown>;
    try {
      conf = record(JSON.parse(requiredText(data.captchaConf)));
    } catch {
      return malformed();
    }
    if (!['true', 'false'].includes(String(conf.notCheckCaptcha))) return malformed();
    const servers = (value: unknown, fallback: string): string[] => {
      if (value === undefined) return [fallback];
      if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) return malformed();
      return value;
    };
    return {
      captchaId: requiredText(conf.gt),
      captchaType: requiredText(conf.captchaType),
      required: String(conf.notCheckCaptcha) !== 'true',
      apiServers: servers(conf.apiServers, 'captcha.changyan.com/captcha/api'),
      staticServers: servers(conf.staticServers, 'captcha.changyan.com/captcha/static'),
    };
  }

  async login(options: {
    username: string;
    password: string;
    seccode?: CaptchaSeccode;
  }): Promise<AccountSession> {
    if (!options.username || !options.password) {
      throw new RemoteKitError('invalid_request', '请输入畅言账号和密码');
    }
    const policy = await this.captchaPolicy();
    if (
      policy.required &&
      (!options.seccode ||
        ![
          options.seccode.captchaOutput,
          options.seccode.genTime,
          options.seccode.lotNumber,
          options.seccode.passToken,
        ].every((value) => typeof value === 'string' && value.length > 0))
    ) {
      throw new RemoteKitError('rejected', '本次登录需要极验验证，请先完成验证并提供 Geetest v4 seccode');
    }
    const seccode = options.seccode;
    const grant = toSso(
      await this.sso({
        encode: 'true',
        method: 'sso.login.account.v2',
        captchaType: policy.captchaType,
        ...clientIdentity(),
        ...networkIdentity(true),
        needToken: 'false',
        ...extendedIdentity(),
        password: encryptPassword(options.password),
        ncetAppId: '',
        encodeType: 'R2/P',
        ...(seccode
          ? {
              thirdCaptchaParam: JSON.stringify({
                captcha_output: seccode.captchaOutput,
                gen_time: seccode.genTime,
                lot_number: seccode.lotNumber,
                pass_token: seccode.passToken,
              }),
            }
          : {}),
        useAreaExamNo: 'false',
        ...platformIdentity(),
        key: 'auto',
        username: options.username,
      }),
      undefined,
    );
    return this.renew({ sso: grant });
  }

  async renew(session: Pick<AccountSession, 'sso'> & Partial<AccountSession>): Promise<AccountSession> {
    const grant = await this.sso({
      tgt: session.sso.tgt,
      method: 'sso.create.token',
      ...clientIdentity(),
      ...networkIdentity(true),
      ...extendedIdentity(),
      ncetAppId: '',
      scope: 'openapi apigateway',
      ...platformIdentity(),
    });
    const expiresIn = number(grant.expireIn);
    if (expiresIn === undefined || expiresIn <= 0) return malformed();
    const sso = toSso(grant, session.sso);
    const now = Date.now();
    return {
      ...session,
      sso,
      changyan: {
        token: requiredText(grant.token),
        userId: sso.userId,
        createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + expiresIn * 1000).toISOString(),
      },
    };
  }

  ensureFresh(session: AccountSession): Promise<AccountSession> {
    if (Date.parse(session.changyan.expiresAt) - Date.now() >= 5 * 60_000) return Promise.resolve(session);
    return this.renew(session);
  }

  async extendForZhixue(session: AccountSession): Promise<AccountSession> {
    const grant = await this.sso({
      tgt: session.sso.tgt,
      method: 'sso.extend.tgt',
      ...platformIdentity(AUTH_CONFIG.zhixue.ssoAppId),
      ...clientIdentity(),
      ...networkIdentity(),
      ...extendedIdentity(),
    });
    return { ...session, sso: toSso(grant, session.sso) };
  }

  private async sso(form: Record<string, string>): Promise<Record<string, unknown>> {
    return this.http.retry(async () => {
      const envelope = record(
        await this.http.json(
          'https://open.changyan.com/sso/v1/api',
          {
            method: 'POST',
            headers: {
              'content-type': 'application/x-www-form-urlencoded',
              'user-agent': AUTH_CONFIG.sso.httpUserAgent,
            },
            body: new URLSearchParams(form),
          },
          0,
        ),
      );
      if (typeof envelope.code !== 'string') return malformed();
      if (envelope.code !== 'success') {
        try {
          serviceError(envelope.code, '畅言', !/captcha/.test(envelope.code));
        } catch (error) {
          if (
            error instanceof RemoteKitError &&
            typeof envelope.message === 'string' &&
            /[\u4e00-\u9fff]/.test(envelope.message)
          )
            throw new RemoteKitError(error.code, envelope.message.slice(0, 256));
          throw error;
        }
      }
      return record(envelope.data);
    });
  }
}

function toSso(grant: Record<string, unknown>, fallback: SsoSession | undefined): SsoSession {
  return {
    tgt: requiredText(grant.tgt || fallback?.tgt),
    at: requiredText(grant.at || fallback?.at),
    userId: requiredText(grant.userId || fallback?.userId),
  };
}

function clientIdentity(): Record<string, string> {
  return {
    userAgent: AUTH_CONFIG.sso.userAgent,
    userProxy: 'false',
    deviceId: AUTH_CONFIG.device.id,
    deviceName: AUTH_CONFIG.sso.deviceName,
  };
}

function platformIdentity(appId = AUTH_CONFIG.sso.id): Record<string, string> {
  return { appId, osType: 'android', client: 'android' };
}

function networkIdentity(mac = false): Record<string, string> {
  return { ...(mac ? { mac: AUTH_CONFIG.device.mac } : {}), networkState: AUTH_CONFIG.device.network };
}

function extendedIdentity(): Record<string, string> {
  return { extInfo: JSON.stringify({ deviceId: AUTH_CONFIG.device.id }) };
}
