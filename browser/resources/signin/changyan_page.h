// Generated from changyan.html by compile_page.py.
#pragma once
inline constexpr char kChangyanPage[] = R"rkpage(<!doctype html>
<html lang="zh-CN">
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>安全验证</title>
  <style>
    html, body { height: 100%; margin: 0; }
    body { display: grid; place-items: center; background: white; color: #222; font: 16px system-ui, sans-serif; }
    main { text-align: center; }
    button { padding: 8px 20px; font: inherit; cursor: pointer; }
  </style>
  <main>
    <p>请完成安全验证</p>
    <button id="retry" hidden>重新验证</button>
  </main>
  <script>
    const query = new URLSearchParams(location.search);
    const retry = document.getElementById('retry');
    let captcha;
    function showRetry() { retry.hidden = false; }
    retry.onclick = () => {
      retry.hidden = true;
      if (captcha) captcha.showCaptcha();
      else location.reload();
    };
    function start() {
      try {
        initGeetest4({
          captchaId: query.get('captchaId'),
          challenge: query.get('challenge'),
          product: 'bind',
          language: 'zho',
          protocol: 'https://',
          apiServers: JSON.parse(query.get('apiServers') || '[]'),
          staticServers: JSON.parse(query.get('staticServers') || '[]'),
        }, (widget) => {
          captcha = widget;
          widget.onReady(() => {
            document.documentElement.dataset.captchaReady = 'true';
            widget.showCaptcha();
          });
          widget.onClose(showRetry);
          widget.onError(showRetry);
          widget.onSuccess(() => {
            const result = widget.getValidate();
            if (!result) return showRetry();
            const done = new URL('remotekit-signin://changyan/done');
            for (const name of ['lot_number', 'captcha_output', 'pass_token', 'gen_time']) {
              if (typeof result[name] !== 'string' || !result[name]) return showRetry();
              done.searchParams.set(name, result[name]);
            }
            location.assign(done.href);
          });
        });
      } catch { showRetry(); }
    }
  </script>
  <script src="https://static.geetest.com/v4/gt4.js" onload="start()" onerror="showRetry()"></script>
</html>
)rkpage";
