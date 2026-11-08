import { randomUUID } from 'node:crypto';
import { HttpClient, type HttpOptions, record, malformed, serviceError } from '../http.js';
import type { ProviderResult } from '../models.js';
import { AuthClient, type AccountSession } from './auth.js';
import { AUTH_CONFIG } from './config.js';
import { gatewaySignatureWithAppId } from './crypto.js';

export interface GatewayRequest {
  path: string;
  groupId: string;
  query?: Record<string, string | number | undefined>;
}

export class GatewayClient {
  private readonly http: HttpClient;
  private readonly auth: AuthClient;
  private readonly now: () => number;
  private readonly nonce: () => string;
  private readonly gatewayUrl = 'https://xktptapi.changyan.com';

  constructor(options: HttpOptions & { now?: () => number; nonce?: () => string } = {}) {
    this.http = new HttpClient(options, 'changyan');
    this.auth = new AuthClient(options);
    this.now = options.now ?? Date.now;
    this.nonce = options.nonce ?? randomUUID;
  }

  async gateway<T>(
    input: AccountSession,
    request: GatewayRequest,
  ): Promise<ProviderResult<T, AccountSession>> {
    const session = await this.auth.ensureFresh(input);
    const method = 'GET';
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined) query.append(key, String(value));
    }
    const pathWithQuery = query.size ? `${request.path}?${query}` : request.path;
    const timestamp = String(this.now());
    const nonce = this.nonce();
    const { gateway, device } = AUTH_CONFIG;
    const headers: Record<string, string> = {
      'User-Agent': gateway.userAgent,
      'S-Auth-Version': '1',
      'S-SDK-Version': gateway.sdkVersion,
      'S-Auth-Stage': gateway.stage,
      'S-Auth-AppId': gateway.appId,
      'S-Auth-Timestamp': timestamp,
      'S-Auth-Nonce': nonce,
      'S-Auth-GroupId': request.groupId,
      'S-Auth-Token': session.changyan.token,
      'S-Token-UserId': session.changyan.userId,
      'S-Auth-DeviceId': device.id,
      'S-Auth-ClientType': 'android',
      'S-Auth-Mac': device.mac,
      sucUserToken: session.changyan.token,
      sucClientType: 'android',
      sucOriginAppKey: gateway.appId,
      sucAccessIp: device.accessIp,
      sucAccessDeviceId: device.id,
      'kt-platform': '2',
      'kt-sn': device.serialNumber,
      'S-Auth-Signature': gatewaySignatureWithAppId(
        gateway.secret,
        gateway.appId,
        pathWithQuery,
        nonce,
        timestamp,
      ),
    };
    return this.http.retry(async () => {
      const envelope = record(
        await this.http.json(
          `${this.gatewayUrl}${pathWithQuery}`,
          {
            method,
            headers,
          },
          0,
        ),
      );
      if (typeof envelope.code !== 'number' && typeof envelope.code !== 'string') return malformed();
      if (Number(envelope.code) !== 200) serviceError(envelope.code, '畅言');
      if (envelope.data === undefined || envelope.data === null) return malformed();
      return { data: envelope.data as T, session };
    });
  }
}
