// Rebuilds a damaged Control database: the old files move aside and a fresh database gets only
// the accounts and their credentials. See docs/auth.md#凭据恢复.
import { existsSync, mkdirSync, renameSync, rmdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { runtimeConfig } from './config';
import { open } from './persistence/database';
import { applyRecovery, planRecovery, type RecoveryPlan } from './recovery/credentials';

const usage = `用法: recover-credentials [选项]

停止 Control 后运行。默认把配置中的数据库及其 -wal/-shm/key 移到
<数据库>.damaged-<时间>/，新建空库，只写回账户、密码、PIN、人脸与登录 token。

  --from <文件>       从已移走的旧库恢复（配置中的数据库须不存在或没有账户）
  --from-key <文件>   旧库的 key（默认 <旧库>.key，其次 <旧库>.face-key）
  --admin <用户名>    旧库没有管理员时指定一个（默认最早的未停用账户）
  --no-tokens         不恢复登录 token，所有设备重新登录
  --dry-run           只报告，不移动、不写入`;

function fail(message: string): never {
  console.error('错误: ' + message);
  process.exit(1);
}

function parse(argv: string[]) {
  const options = { tokens: true, dryRun: false } as {
    from?: string;
    sourceKey?: string;
    admin?: string;
    tokens: boolean;
    dryRun: boolean;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => argv[++i] ?? fail(`${arg} 缺少参数`);
    if (arg === '--from') options.from = resolve(value());
    else if (arg === '--from-key') options.sourceKey = resolve(value());
    else if (arg === '--admin') options.admin = value();
    else if (arg === '--no-tokens') options.tokens = false;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '-h' || arg === '--help') {
      console.log(usage);
      process.exit(0);
    } else fail(`未知参数 ${arg}\n\n${usage}`);
  }
  return options;
}

const stamp = (date: Date) =>
  date
    .toISOString()
    .replace(/\.\d+Z$/, '')
    .replace(/[-:]/g, '')
    .replace('T', '-');

// The database file goes first: while Control still has it open Windows refuses the rename
// and nothing has moved yet.
function moveAside(database: string, now: Date) {
  let destination = `${database}.damaged-${stamp(now)}`;
  for (let attempt = 2; existsSync(destination); attempt++)
    destination = `${database}.damaged-${stamp(now)}-${attempt}`;
  mkdirSync(destination);
  const moved: [string, string][] = [];
  try {
    for (const suffix of ['', '-wal', '-shm', '.key', '.face-key']) {
      const from = database + suffix;
      if (!existsSync(from)) continue;
      const to = join(destination, basename(from));
      renameSync(from, to);
      moved.push([from, to]);
    }
  } catch (error) {
    for (const [from, to] of moved.reverse()) renameSync(to, from);
    rmdirSync(destination);
    const code = (error as NodeJS.ErrnoException).code;
    fail(
      code === 'EBUSY' || code === 'EPERM'
        ? `${database} 正被占用，先停止 Control`
        : (error as Error).message,
    );
  }
  return join(destination, basename(database));
}

function report(plan: RecoveryPlan, dryRun: boolean) {
  for (const warning of plan.warnings) console.log('警告: ' + warning);
  for (const skip of plan.skipped) console.log('放弃: ' + skip);
  const pins = plan.users.filter((user) => user.pin).length;
  const faces = plan.users.filter((user) => user.face).length;
  console.log(
    `${dryRun ? '将恢复' : '已恢复'}: 账户 ${plan.users.length}，PIN ${pins}，人脸 ${faces}，token ${plan.tokens.length}`,
  );
  for (const user of plan.users)
    console.log(`  ${user.username}${user.isAdmin ? ' [管理员]' : ''}${user.disabledAt ? ' [已停用]' : ''}`);
}

function main() {
  const options = parse(process.argv.slice(2));
  const database = runtimeConfig(process.env, []).dbPath;
  const now = new Date();
  let source = options.from ?? database;
  if (!existsSync(source)) fail(`${source} 不存在`);
  const plan = planRecovery(source, { ...options, now: now.getTime() });
  if (!plan.users.length) fail('旧库中没有可恢复的账户，未做任何改动');
  if (options.dryRun) {
    report(plan, true);
    return;
  }
  if (!options.from) {
    source = moveAside(database, now);
    console.log(`旧库已移到 ${dirname(source)}`);
  }
  mkdirSync(dirname(database), { recursive: true });
  const store = open(database);
  let failure: Error | undefined;
  try {
    applyRecovery(store, plan);
  } catch (error) {
    failure = error as Error;
  }
  store.db.close();
  if (failure) fail(`${failure.message}；旧库在 ${source}，可用 --from 重试`);
  report(plan, false);
  console.log(`新库: ${database}`);
}

try {
  main();
} catch (error) {
  fail((error as Error).message);
}
