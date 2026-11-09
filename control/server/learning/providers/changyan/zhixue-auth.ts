import { randomBytes, randomUUID } from 'node:crypto';
import { HttpClient, type HttpOptions, record, malformed, requiredText, serviceError } from '../http.js';
import { AUTH_CONFIG } from './config.js';
import { AuthClient, type AccountSession, type CaptchaChallenge } from './auth.js';

const ZHIXUE_BASE_URL = 'https://www.zhixue.com';

export interface ZhixueSession {
  token: string;
  accountId: string;
  studentId: string;
  classId?: string;
  schoolId?: string;
  gradeCode?: string;
  phaseCode?: string;
  cookies?: Record<string, string>;
  createdAt: string;
  expiresAt: string;
}

export class ZhixueAuthClient {
  private readonly http: HttpClient;
  private readonly auth: AuthClient;
  private readonly now: () => number;
  private readonly uuid: () => string;
  private readonly randomHex: () => string;

  constructor(
    options: HttpOptions & { now?: () => number; uuid?: () => string; randomHex?: () => string } = {},
  ) {
    this.http = new HttpClient(options, 'zhixue');
    this.auth = new AuthClient(options);
    this.now = options.now ?? Date.now;
    this.uuid = options.uuid ?? randomUUID;
    this.randomHex = options.randomHex ?? (() => randomBytes(16).toString('hex'));
  }

  async loginAccount(
    options: Parameters<AuthClient['login']>[0],
  ): Promise<AccountSession | CaptchaChallenge> {
    const result = await this.auth.login(options);
    return 'challenge' in result ? result : this.renew(result);
  }

  async renew(input: AccountSession): Promise<AccountSession> {
    const session = await this.auth.extendForZhixue(input);
    const { result, cookies } = await this.casLogin(session.sso.at, session.sso.userId, session.zhixue);
    try {
      return {
        ...session,
        zhixue: fromLogin(result, cookies),
        displayName: result.userInfo?.name || session.displayName,
      };
    } catch {
      return malformed();
    }
  }

  ensureFresh(session: AccountSession): Promise<AccountSession> {
    if (session.zhixue && Date.parse(session.zhixue.expiresAt) - Date.now() >= 5 * 60_000)
      return Promise.resolve(session);
    return this.renew(session);
  }

  private async casLogin(
    accessTicket: string,
    userId: string,
    previous?: ZhixueSession,
  ): Promise<{ result: CasLoginResult; cookies: Record<string, string> }> {
    return this.http.retry(async () => {
      const timestamp = String(this.now());
      const authGuid = this.uuid();
      const axRequestId = this.uuid().replace(/-/g, '');
      const headers: Record<string, string> = {
        'content-type': 'application/x-www-form-urlencoded',
        'user-agent': AUTH_CONFIG.zhixue.httpUserAgent,
        deviceId: Buffer.from(AUTH_CONFIG.device.zhixueInstallationId).toString('base64'),
        browserVersion: `Android_${AUTH_CONFIG.zhixue.version}`,
        channelId: `Android_${AUTH_CONFIG.zhixue.channel}`,
        deviceMac: Buffer.from(AUTH_CONFIG.device.zhixueDeviceMac).toString('base64'),
        appName: AUTH_CONFIG.zhixue.packageName,
        channel: AUTH_CONFIG.zhixue.channel,
        resolution: AUTH_CONFIG.zhixue.resolution,
        authbizcode: AUTH_CONFIG.zhixue.authBizCode,
        authguid: authGuid,
        authtimestamp: timestamp,
        authtoken: this.randomHex(),
        userId: AUTH_CONFIG.device.zhixueUserId,
        deviceType: AUTH_CONFIG.zhixue.deviceType,
        deviceName: AUTH_CONFIG.zhixue.deviceName,
        sucUserToken: previous?.token ?? '',
        sucAccessDeviceId: AUTH_CONFIG.device.id,
        sucOriginAppKey: AUTH_CONFIG.sso.id,
        'AX-BID': AUTH_CONFIG.zhixue.axBusinessId,
        'AX-CTS': timestamp,
        'AX-RID': axRequestId,
        'AX-SIGN': this.randomHex(),
        ...cookieHeader(previous?.cookies),
      };
      const url = `${ZHIXUE_BASE_URL}/container/app/login/casLogin`;
      const init = {
        method: 'POST',
        headers,
        body: new URLSearchParams({
          at: accessTicket,
          loginType: '',
          tokenTimeout: '0',
          userId,
          autoLogin: 'true',
        }),
      };
      const response = await this.http.response(url, init, 0);
      const envelope = record(await this.http.parseJson(response, url, init)) as {
        errorCode?: number;
        errorInfo?: string;
        result?: CasLoginResult;
      };
      if (typeof envelope.errorCode !== 'number') return malformed();
      if (envelope.errorCode !== 0) serviceError(envelope.errorCode, '智学', true);
      if (!envelope.result?.token) return malformed();
      return {
        result: envelope.result,
        cookies: { ...(previous?.cookies ?? {}), ...responseCookies(response.headers) },
      };
    }, false);
  }
}

function cookieHeader(cookies?: Record<string, string>): Record<string, string> {
  if (!cookies || !Object.keys(cookies).length) return {};
  return {
    cookie: Object.entries(cookies)
      .map(([name, value]) => `${name}=${value}`)
      .join('; '),
  };
}

function responseCookies(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  const values = headers.getSetCookie();
  for (const value of values) {
    const pair = value.split(';', 1)[0];
    const separator = pair?.indexOf('=') ?? -1;
    if (pair && separator > 0) result[pair.slice(0, separator)] = pair.slice(separator + 1);
  }
  return result;
}

function fromLogin(cas: CasLoginResult, cookies: Record<string, string>): ZhixueSession {
  requiredText(cas.id);
  const children = Array.isArray(cas.childrens) ? cas.childrens : [];
  const child =
    children.find((item) => item.isChange) ??
    children[0] ??
    (cas.role === 'student' || cas.roles?.includes('student')
      ? {
          id: cas.id,
          ...(cas.userInfo?.name ? { name: cas.userInfo.name } : {}),
          ...(cas.clazzInfo ? { clazzInfo: cas.clazzInfo } : {}),
        }
      : undefined);
  if (!child) malformed();
  const times = jwtTimes(cas.token);
  return {
    token: cas.token,
    accountId: cas.id,
    studentId: requiredText(child.id),
    createdAt: times.createdAt,
    expiresAt: times.expiresAt,
    ...(child.clazzInfo?.id ? { classId: child.clazzInfo.id } : {}),
    ...(child.clazzInfo?.schoolId ? { schoolId: child.clazzInfo.schoolId } : {}),
    ...(child.clazzInfo?.gradeCode ? { gradeCode: child.clazzInfo.gradeCode } : {}),
    ...(child.clazzInfo?.phase ? { phaseCode: child.clazzInfo.phase } : {}),
    ...(Object.keys(cookies).length ? { cookies } : {}),
  };
}

export interface CasLoginResult {
  token: string;
  id: string;
  role?: string;
  roles?: string[];
  userInfo?: { name?: string; loginName?: string };
  clazzInfo?: { id?: string; schoolId?: string; gradeCode?: string; phase?: string };
  childrens?: Array<{
    id: string;
    name?: string;
    isChange?: boolean;
    clazzInfo?: { id?: string; schoolId?: string; gradeCode?: string; phase?: string };
  }>;
}

function jwtTimes(token: string): { createdAt: string; expiresAt: string } {
  const parts = token.split('.');
  if (parts.length !== 3 || !parts[1]) malformed();
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as {
    iat?: number;
    exp?: number;
  };
  if (!payload.iat || !payload.exp) malformed();
  return {
    createdAt: new Date(payload.iat * 1000).toISOString(),
    expiresAt: new Date(payload.exp * 1000).toISOString(),
  };
}
