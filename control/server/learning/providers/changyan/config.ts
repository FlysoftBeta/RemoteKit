/** Fixed application and device identity reproduced in authenticated requests. */
export interface AuthConfig {
  sso: {
    id: string;
    userAgent: string;
    httpUserAgent: string;
    deviceName: string;
  };
  gateway: {
    appId: string;
    secret: string;
    stage: string;
    sdkVersion: string;
    userAgent: string;
  };
  zhixue: {
    ssoAppId: string;
    appId: string;
    version: string;
    packageName: string;
    httpUserAgent: string;
    channel: string;
    resolution: string;
    authBizCode: string;
    axBusinessId: string;
    webViewUserAgent: string;
    deviceType: string;
    deviceName: string;
  };
  device: {
    id: string;
    mac: string;
    network: string;
    accessIp: string;
    serialNumber: string;
    zhixueInstallationId: string;
    zhixueDeviceMac: string;
    zhixueUserId: string;
  };
}

export const AUTH_CONFIG: AuthConfig = {
  sso: {
    id: 'YFil5acT',
    userAgent: '畅言学生登录',
    httpUserAgent: 'okhttp/3.14.0',
    deviceName: 'iFLYTEK,CB-C6-STU,CB-C6-STU',
  },
  gateway: {
    appId: 'YFil5acT',
    secret: '9mzUQjwEUeuUs6mVz6aegJRZHiFEDASs',
    stage: 'RELEASE',
    sdkVersion: '1.0.6',
    userAgent: 'ShieldAndroidSDK',
  },
  zhixue: {
    ssoAppId: 'zhixue_parent',
    appId: 'OAXI57PG',
    version: '1.8.2588',
    packageName: 'com.iflytek.elpmobile.smartlearning',
    httpUserAgent: 'okhttp/3.12.12',
    channel: '11010007',
    resolution: '2800*1272',
    authBizCode: '0001',
    axBusinessId: 'aixueResourceRecommend',
    webViewUserAgent:
      'Mozilla/5.0 (Linux; Android 16; PLR110 Build/BP2A.250605.015; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/150.0.7871.181 Mobile Safari/537.36',
    deviceType: 'iFLYTEK AIPad',
    deviceName: encodeURIComponent('CB-C6-STU'),
  },
  device: {
    id: 'b1d5931f855bbe31ed8eb7ba3b9ebfcb',
    mac: '02:00:00:00:00:00',
    network: 'wifi',
    accessIp: '192.168.110.61',
    serialNumber: 'unknown',
    zhixueInstallationId: '8e27e6e3-9e84-4ded-a826-456120debd77',
    zhixueDeviceMac: '0fa1d62e-80c1-48b7-9411-2f45c7d7215a-427882ec-6b56-4648-a3ac-d90923f457e5',
    zhixueUserId: '549dd8718d0f56ecc952d2411be637119b0136',
  },
};
