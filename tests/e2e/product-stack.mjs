export async function registerViewer({ click, fill, username, password }) {
  await fill('input[autocomplete="username"]', username);
  await fill('input[autocomplete="new-password"]', password);
  await click('button[type="submit"]', '创建并登录');
}
