import Sqlite from 'better-sqlite3';
import { execFileSync, spawnSync } from 'node:child_process';
import { createCipheriv, createHash, hkdfSync } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const destination = dirname(fileURLToPath(import.meta.url));
const control = resolve(destination, '../..');
const commits = {
  12: '075293534b74e704a5b098229aaef84af124de4d',
  13: '47465ad4e61566d865565ee58306c325955cd588',
  14: '94611badb19b2065b0dff51b50a84bf15aab1449',
  15: '94611badb19b2065b0dff51b50a84bf15aab1449',
  16: '86175d45fc97b1d4b288b5679c03dd9962c5a4ad',
};
const master = Buffer.alloc(32, 7);
function seal(aad: string, value: unknown, key: Buffer = master) {
  const iv = createHash('sha256').update(aad).digest().subarray(0, 12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
}
function quote(value: unknown): string {
  if (value === null) return 'NULL';
  if (Buffer.isBuffer(value)) return `X'${value.toString('hex')}'`;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return `'${String(value).replace(/'/g, "''")}'`;
}
function insert(db: Sqlite.Database, table: string, row: Record<string, unknown>) {
  db.prepare(
    `INSERT INTO ${table} (${Object.keys(row).join(',')}) VALUES (${Object.keys(row)
      .map(() => '?')
      .join(',')})`,
  ).run(
    ...Object.values(row).map((value) =>
      value !== null && typeof value === 'object' && !Buffer.isBuffer(value) ? JSON.stringify(value) : value,
    ),
  );
}

for (const [versionText, commit] of Object.entries(commits)) {
  const version = Number(versionText);
  const ancestry = spawnSync(
    'git',
    ['merge-base', '--is-ancestor', 'dfb602be3d3873babfd3032634af2187870d685a', commit],
    { cwd: control },
  );
  if (ancestry.status !== 0 && ancestry.status !== 1) throw new Error('Cannot resolve fixture ancestry');
  const hasDeviceIdentity = ancestry.status === 0;
  const temporary = mkdtempSync(join(tmpdir(), 'rk-historical-'));
  try {
    writeFileSync(join(temporary, 'package.json'), '{"type":"module"}');
    symlinkSync(join(control, 'node_modules'), join(temporary, 'node_modules'), 'junction');
    for (const file of [
      'server/persistence/schema.ts',
      'server/persistence/learning.ts',
      'server/persistence/announcements.ts',
      'shared/errors.ts',
      ...(version >= 13 ? ['server/persistence/object-renders.ts', 'server/learning/document-type.ts'] : []),
    ]) {
      let source = execFileSync('git', ['show', `${commit}:control/${file}`], {
        cwd: control,
        encoding: 'utf8',
      });
      // v14 exists only as the intermediate placement migration in the v15 commit.
      if (version === 14 && file.endsWith('/schema.ts'))
        source += '\nexport const placementMigration = migrations[13];\n';
      const target = join(temporary, file);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, source);
    }
    const historical = await import(pathToFileURL(join(temporary, 'server/persistence/schema.ts')).href);
    const db = new Sqlite(':memory:');
    if (version === 14) {
      const v13 = execFileSync('git', ['show', `${commits[13]}:control/server/persistence/schema.ts`], {
        cwd: control,
        encoding: 'utf8',
      });
      writeFileSync(join(temporary, 'server/persistence/v13.ts'), v13);
      (await import(pathToFileURL(join(temporary, 'server/persistence/v13.ts')).href)).createSchema(db);
      historical.placementMigration(db);
      db.exec(
        'DROP TABLE schema_version; CREATE TABLE schema_version (version INTEGER NOT NULL CHECK(version=14)); INSERT INTO schema_version VALUES (14)',
      );
    } else historical.createSchema(db);
    insert(db, 'users', {
      id: 'user',
      username: 'fixture',
      tenant: 'tenant',
      salt: '00'.repeat(16),
      password_hash: '00'.repeat(64),
      is_admin: 1,
    });
    insert(db, 'workspaces', {
      tenant: 'tenant',
      revision: 3,
      active_space: 'space',
      pending: { pendingClose: null, pendingWindowCloseId: null },
    });
    insert(db, 'workspace_windows', {
      id: 'window',
      tenant: 'tenant',
      position: 0,
      app_id: 'browser',
      active_tab: 'tab',
      state: { query: 'lesson' },
      last_active_at: 100,
    });
    insert(db, 'workspace_spaces', {
      id: 'space',
      tenant: 'tenant',
      position: 0,
      data: {
        id: 'space',
        windowIds: ['window'],
        weights: [1],
        focusedWindowId: 'window',
        lastActiveAt: 100,
      },
    });
    insert(db, 'workspace_tabs', {
      id: 'tab',
      tenant: 'tenant',
      window_id: 'window',
      position: 0,
      data: {
        id: 'tab',
        windowId: 'window',
        webviewId: '1',
        kind: 'remote',
        title: 'Lesson',
        url: 'https://example.test/',
      },
    });
    insert(db, 'user_settings', {
      tenant: 'tenant',
      data: {
        workspace: {
          qualityPreference: 'auto',
          uiScale: 1,
          topDeadZone: 'off',
          showStats: false,
          autoFullscreen: false,
          ...(version >= 13 ? { autoKeyboard: false } : {}),
          ...(version >= 16 ? { clipboardSync: true } : {}),
          avSync: false,
          audioChannels: { left: true, right: true },
        },
        browser: { searchEngine: 'google', memorySaverEnabled: true },
      },
    });
    insert(db, 'site_preferences', {
      tenant: 'tenant',
      origin: 'https://example.test',
      data: {
        tabletUa: true,
        ...(version === 12 ? { manualKeyboard: true } : {}),
        permissions: { clipboard_read: 'allow' },
        protocolHandlers: [{ protocol: 'web+lesson', url: 'https://example.test/%s', allowed: true }],
      },
    });
    insert(db, 'installed_apps', {
      tenant: 'tenant',
      id: 'app',
      position: 0,
      data: {
        id: 'app',
        name: 'Lessons',
        startUrl: 'https://example.test/',
        scope: 'https://example.test/',
        display: 'standalone',
        createdAt: 100,
        updatedAt: 100,
      },
    });
    insert(db, 'favorites', {
      tenant: 'tenant',
      id: 'favorite',
      position: 0,
      data: { id: 'favorite', url: 'https://example.test/', title: 'Lessons', createdAt: 100 },
    });
    for (const [id, status, error] of [
      [
        'failed',
        version < 15 ? 'rejected' : 'failed',
        version < 15 ? 'Navigation rejected' : { code: 'rejected', message: 'Navigation rejected' },
      ],
      [
        'expired',
        version < 15 ? 'expired' : 'failed',
        version < 15 ? '' : { code: 'conflict', message: 'Expired' },
      ],
      [
        'unknown',
        'unknown',
        version < 15 ? 'Lost reply' : { code: 'outcome_unknown', message: 'Lost reply' },
      ],
    ])
      insert(db, 'operation_receipts', {
        tenant: 'tenant',
        id,
        payload: { type: 'tab.navigate', tabId: 'tab', url: 'https://example.test/next' },
        receipt: { operationId: id, operationGeneration: 'generation', status, error },
      });
    insert(db, 'operation_receipts', {
      tenant: 'tenant',
      id: 'settings',
      payload: { type: 'settings.update', settings: { memorySaverEnabled: true } },
      receipt: { operationId: 'settings', operationGeneration: 'generation', status: 'committed' },
    });
    insert(db, 'user_security', {
      user_id: 'user',
      settings: { lockOnHidden: true },
      face_ciphertext: seal(JSON.stringify(['user', 'model']), [1, ...Array(127).fill(0)]),
      face_model: 'model',
    });
    const entry = {
      id: 'entry',
      name: 'lesson.pdf',
      type: 'application/pdf',
      size: 42,
      createdAt: 100,
      source: { app: 'study', channel: 'class' },
      partitionId: 'saved',
      collected: true,
      ...(version >= 16 ? { kind: 'file' } : {}),
      assetId: 'a'.repeat(64),
      originalAssetId: 'b'.repeat(64),
      photo: { mode: 'scan', candidateAssetIds: ['c'.repeat(64)] },
    };
    const snippet = {
      kind: 'snippet',
      id: 'snippet',
      name: '',
      type: 'text/plain',
      size: 6,
      createdAt: 101,
      source: { app: 'clipboard', channel: '' },
      partitionId: null,
      collected: true,
      preview: 'Copied',
      origin: { kind: 'device' },
    };
    insert(db, 'file_library', {
      tenant: 'tenant',
      snapshot: {
        revision: 3,
        entries: [entry, ...(version >= 16 ? [snippet] : [])],
        basket: ['entry'],
        partitions: [{ id: 'saved', name: 'Saved' }],
        sources: [],
        excludedSources: [{ app: 'download', channel: 'example.test' }],
        basketPartitionId: 'saved',
      },
    });
    insert(db, 'file_library_selections', {
      tenant: 'tenant',
      id: 'selection',
      manifest: {
        selectionId: 'selection',
        requestId: 'request',
        binding: {
          browserIncarnation: 'browser',
          view: '1',
          instance: 'instance',
          document: 'document',
          request: 'request',
        },
        entryIds: ['entry'],
        files: [{ assetId: entry.assetId, name: entry.name, type: entry.type }],
        prepared: true,
      },
    });
    insert(db, 'learning_accounts', {
      tenant: 'tenant',
      provider: 'changyan',
      sealed: seal(
        JSON.stringify(['tenant', 'changyan']),
        {
          sso: { tgt: 'tgt', at: 'at', userId: 'student' },
          changyan: { token: 'token', userId: 'student', createdAt: '2026-01-01', expiresAt: '2027-01-01' },
        },
        Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), 'remotekit learning account key 1', 32)),
      ),
      display_name: 'Student',
      username: 'student',
      status: 'signed_in',
      updated_at: 100,
    });
    insert(db, 'learning_accounts', {
      tenant: 'tenant',
      provider: 'xinjiaoyu',
      sealed: seal(
        JSON.stringify(['tenant', 'xinjiaoyu']),
        {
          token: 'xinjiaoyu-token',
          accessToken: 'xinjiaoyu-access',
          clientSessionId: 'fixture-client',
          ...(hasDeviceIdentity
            ? { device: 'fixture-device', deviceType: 'fixture-device-type' }
            : { cookie: 'session=fixture-cookie' }),
          safeCode: 'fixture-safe-code',
        },
        Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), 'remotekit learning account key 1', 32)),
      ),
      display_name: 'Xinjiaoyu Student',
      username: 'xinjiaoyu-student',
      status: 'signed_in',
      updated_at: 101,
    });
    insert(db, 'learning_downloads', {
      tenant: 'tenant',
      key: 'lesson',
      published_at: 90,
      saved_at: 100,
      entry_id: 'entry',
      object_id: entry.assetId,
      state: 'saved',
    });
    insert(db, 'session_import_pairing', {
      tenant: 'tenant',
      code: seal('session-import-pairing:tenant', ['one', 'two', 'three']),
      opened_at: 100,
      expires_at: 100000,
      failures: 0,
    });
    insert(db, 'session_imports', {
      id: 'import',
      tenant: 'tenant',
      key_id: 'device',
      sites: [{ name: 'Example', url: 'https://example.test/' }],
      state: 'pending',
      payload: seal(JSON.stringify(['session-import', 'tenant', 'import']), {
        cookies: [
          {
            name: 'session',
            value: 'secret',
            domain: 'example.test',
            path: '/',
            hostOnly: true,
            secure: true,
            httpOnly: true,
            sameSite: 'lax',
            expires: null,
          },
        ],
        localStorage: [{ origin: 'https://example.test', items: [['theme', 'dark']] }],
        ref: 1,
      }),
      cookies: 1,
      origins: 1,
      rejected_items: 0,
      received_at: 100,
      ...(version >= 15
        ? {
            storage_job: { importId: 'job' },
            apply_counts: { cookies: { applied: 1, rejected: 0 }, localStorage: { applied: 0, rejected: 0 } },
          }
        : {}),
    });
    insert(db, 'session_import_events', {
      tenant: 'tenant',
      key_id: 'device',
      direction: 'out',
      seq: 1,
      at: 100,
      type: 'importFailed',
      ref: 1,
      body: {
        seq: 1,
        at: 100,
        type: 'importFailed',
        ref: 1,
        id: 'import',
        reason: 'Unavailable',
        ...(version >= 15 ? { retryable: false } : {}),
      },
    });
    insert(db, 'session_import_events', {
      tenant: 'tenant',
      key_id: 'device',
      direction: 'in',
      seq: 1,
      at: 100,
      type: 'import',
      body: {
        seq: 1,
        at: 100,
        receivedAt: 101,
        type: 'import',
        id: 'import',
        device: 'Phone',
        publicKey: 'a2V5',
        sites: [{ name: 'Example', url: 'https://example.test/' }],
        cookies: 1,
        origins: 1,
      },
    });
    if (version >= 16)
      insert(db, 'library_snippets', {
        entry_id: 'snippet',
        tenant: 'tenant',
        text: 'Copied',
        hash: createHash('sha256').update('Copied').digest('hex'),
        origin: { kind: 'device' },
        copied_at: 101,
      });
    if (version >= 15)
      insert(db, 'download_import_failures', {
        tenant: 'tenant',
        event_id: 'download',
        name: 'lesson.pdf',
        origin: 'https://example.test',
        error: { code: 'unavailable', message: 'Unavailable' },
        at: 100,
      });
    const schema = db
      .prepare(
        "SELECT type,name,sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type='index',name",
      )
      .all() as { type: string; name: string; sql: string }[];
    const dump = [
      `-- Generated from commit ${commit}${version === 14 ? ', v13-to-v14 placement step (intermediate version)' : ''}.`,
      ...schema.filter((item) => item.type !== 'index').map((item) => item.sql + ';'),
    ];
    for (const table of schema
      .filter((item) => item.type === 'table')
      .sort((a, b) => Number(b.name === 'users') - Number(a.name === 'users')))
      for (const row of db.prepare(`SELECT * FROM ${table.name} ORDER BY rowid`).all() as Record<
        string,
        unknown
      >[])
        dump.push(
          `INSERT INTO ${table.name} (${Object.keys(row).join(',')}) VALUES (${Object.values(row).map(quote).join(',')});`,
        );
    dump.push(...schema.filter((item) => item.type === 'index').map((item) => item.sql + ';'));
    writeFileSync(join(destination, `control-v${version}.sql`), dump.join('\n') + '\n');
    db.close();
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
