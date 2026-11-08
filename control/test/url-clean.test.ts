import assert from 'node:assert/strict';
import test from 'node:test';
import { cleanUrl } from '../server/url-clean';
import { normalizedUsagePage } from '../server/navigation-url';

test('only credential-free HTTP(S) URLs can be remembered, without fragments or empty queries', () => {
  for (const value of [
    'invalid',
    '',
    'about:blank',
    'file:///secret',
    'ftp://example.com/',
    'https://user@example.com/',
    'https://:password@example.com/',
  ])
    assert.equal(cleanUrl(value), null, value);
  assert.equal(cleanUrl('http://EXAMPLE.com:80/page?#secret'), 'http://example.com/page');
  assert.equal(cleanUrl('https://example.com/#secret'), 'https://example.com/');
});

test('global tracking parameters are removed, including empty, duplicated and encoded names', () => {
  const names = [
    'utm_source',
    'UTM_custom',
    'fbclid',
    'gclid',
    'gclsrc',
    'dclid',
    'msclkid',
    'mc_eid',
    'mc_cid',
    '_hsenc',
    '_hsmi',
    '__hssc',
    '__hstc',
    '__hsfp',
    'hsCtaTracking',
    'igshid',
    'yclid',
    'ysclid',
    '_openstat',
    'oly_anon_id',
    'oly_enc_id',
    'rb_clickid',
    's_cid',
    'vero_conv',
    'vero_id',
    'wickedid',
    'twclid',
    'ttclid',
    'srsltid',
    'gbraid',
    'wbraid',
    'ref_src',
    'mkt_tok',
    'sfmc_activityid',
    'sfmc_id',
    'syclid',
    '_bhlid',
    '_branch_match_id',
    '_branch_referrer',
    '_gl',
    '_kx',
    '__s',
    'at_recipient_id',
    'at_recipient_list',
    'bbeml',
    'bsft_clkid',
    'bsft_uid',
    'et_rid',
    'fb_action_ids',
    'fb_comment_id',
    'guce_referrer',
    'guce_referrer_sig',
    'irclickid',
    'ml_subscriber',
    'ml_subscriber_hash',
    'mtm_cid',
    'oft_c',
    'oft_ck',
    'oft_d',
    'oft_id',
    'oft_ids',
    'oft_k',
    'oft_lk',
    'oft_sk',
    'pk_cid',
    'sc_customer',
    'sc_eh',
    'sc_uid',
    'sms_click',
    'sms_source',
    'sms_uph',
    'ss_email_id',
    'unicorn_click_id',
    'vgo_ee',
    'ymclid',
  ];
  const params = new URLSearchParams(names.map((name) => [name, 'tracking']));
  assert.equal(
    cleanUrl('https://example.com/?' + params + '&utm_source=&fbclid&%67clid=again&keep=1'),
    'https://example.com/?keep=1',
  );
});

test('site rules remove trackers only on their hosts and retain functional query parameters', () => {
  const cases = [
    ['https://www.youtube.com/watch?v=video&si=share&pp=tracking', 'https://www.youtube.com/watch?v=video'],
    ['https://youtu.be/video?si=share&pp=tracking&t=42', 'https://youtu.be/video?t=42'],
    ['https://mobile.x.com/post?s=20&t=share&ref_url=origin&a=1', 'https://mobile.x.com/post'],
    ['https://twitter.com/post?s=20&t=share', 'https://twitter.com/post'],
    [
      'https://www.instagram.com/p/photo?igsh=share&ig_rid=track&stkn=track',
      'https://www.instagram.com/p/photo',
    ],
    ['https://open.spotify.com/track/song?si=share', 'https://open.spotify.com/track/song'],
    [
      'https://www.amazon.co.uk/dp/id/ref=path?tag=affiliate&ref_=track&dib=track',
      'https://www.amazon.co.uk/dp/id/ref=path',
    ],
    ['https://www.reddit.com/post?share_id=track&ref=track', 'https://www.reddit.com/post'],
    [
      'https://example.com/?si=keep&pp=keep&s=keep&t=42&igsh=keep&ref=keep',
      'https://example.com/?igsh=keep&pp=keep&ref=keep&s=keep&si=keep&t=42',
    ],
    ['https://youtube.com.evil.test/?si=keep', 'https://youtube.com.evil.test/?si=keep'],
  ];
  for (const [input, expected] of cases) assert.equal(cleanUrl(input), expected, input);
});

test('secret names, prefixes and fragments are always stripped case-insensitively', () => {
  const names = [
    'code',
    'STATE',
    'Nonce',
    'token',
    'access_token',
    'id_token',
    'refresh_token',
    'client_secret',
    'session',
    'sessionid',
    'sid',
    'auth',
    'password',
    'passwd',
    'otp',
    'ticket',
    'jwt',
    'assertion',
    'samlrequest',
    'SAMLResponse',
    'relaystate',
    'signature',
    'sig',
    'X-Amz-Credential',
    'x-goog-signature',
    'oauth_verifier',
    '__cf_chl_rt_tk',
    'CF_CHL_test',
    'rt_tk',
    'myTokenValue',
    'aSecretValue',
    'userPasswordValue',
    'myApiKey',
    'my_api_key_value',
  ];
  for (const name of names) {
    const params = new URLSearchParams([
      [name, 'private'],
      ['keep', 'yes'],
    ]);
    assert.equal(cleanUrl('https://example.com/?' + params), 'https://example.com/?keep=yes', name);
  }
  assert.equal(cleanUrl('https://example.com/?code=&code=secret&%74oken=secret'), 'https://example.com/');
});

test('JWT-shaped values are stripped under any name without discarding ordinary long IDs', () => {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const params = new URLSearchParams({ data: header + '.eyJzdWIiOiIxIn0.signature', keep: 'value' });
  assert.equal(cleanUrl('https://example.com/?' + params), 'https://example.com/?keep=value');
  for (const value of [
    '4f0c0123456789abcdef0123456789abcdef0123',
    'abc.def.ghi',
    'bnVsbA.e30.sig',
    'eyJ0eXAiOiJKV1QifQ.e30.sig',
  ])
    assert.equal(cleanUrl('https://example.com/?id=' + value), 'https://example.com/?id=' + value);
  assert.equal(
    cleanUrl('https://mail.google.com/mail/u/0/?authuser=0'),
    'https://mail.google.com/mail/u/0/?authuser=0',
  );
});

test('whole sign-in and OAuth path segments discard the entire query', () => {
  for (const path of [
    'oauth',
    'oauth2',
    'authorize',
    'callback',
    'signin',
    'sign-in',
    'login',
    'logout',
    'sso',
    'saml',
    'auth',
    'v3/signin',
    'consent',
  ])
    for (const segment of [path, path.toUpperCase()])
      assert.equal(
        cleanUrl(`https://example.com/account/${segment}/next?keep=private`),
        `https://example.com/account/${segment}/next`,
      );
  assert.equal(
    cleanUrl('https://example.com/login-help?keep=yes'),
    'https://example.com/login-help?keep=yes',
  );
  assert.equal(cleanUrl('https://example.com/author?keep=yes'), 'https://example.com/author?keep=yes');
});

test('real OAuth and challenge URLs are cleaned while search results stay excluded from usage', () => {
  assert.equal(
    normalizedUsagePage(
      'https://accounts.google.com/v3/signin/identifier?opparams=private&client_id=client&nonce=private&state=private&redirect_uri=private',
    ),
    'https://accounts.google.com/v3/signin/identifier',
  );
  assert.equal(
    normalizedUsagePage('https://example.com/callback?code=private&unlisted=private'),
    'https://example.com/callback',
  );
  assert.equal(normalizedUsagePage('https://claude.ai/?__cf_chl_rt_tk=private'), 'https://claude.ai/');
  for (const url of [
    'https://www.google.com/search?q=chatgpt&sei=private',
    'https://www.bing.com/search?q=chatgpt',
    'https://duckduckgo.com/?q=chatgpt',
    'https://www.baidu.com/s?wd=chatgpt',
  ])
    assert.equal(normalizedUsagePage(url), null);
});

test('sorting deduplicates reordered query keys and preserves the order of repeated values', () => {
  const first = normalizedUsagePage(
    'https://example.com/?z=last&b=two&a=first&b=one&utm_source=tracker#fragment',
  );
  const second = normalizedUsagePage('https://example.com/?b=two&b=one&z=last&a=first');
  assert.equal(first, 'https://example.com/?a=first&b=two&b=one&z=last');
  assert.equal(first, second);
  assert.equal(cleanUrl(first!), first);
});
