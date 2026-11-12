import { readFileSync } from 'node:fs';
import { ControlDatabase } from '../../control/server/persistence/database';
import { Placement } from '../../control/server/cluster/placement';
import type { NodeRegistry } from '../../control/server/cluster/node-link';

const input = JSON.parse(readFileSync(0, 'utf8')) as {
  versions: { manifestId: string; takenAt: number; objects: string[] }[];
  available: string[];
};
const store = new ControlDatabase(':memory:', { buildId: 'dev' });
try {
  const nodes = {
    all: () => [{ nodeId: 'replica', state: { state: 'ready' } }],
    isRemoved: () => false,
  } as unknown as NodeRegistry;
  for (const [index, version] of input.versions.entries()) {
    store.db
      .prepare('INSERT INTO checkpoints VALUES (?,?,?,?,?,?)')
      .run('fixture', index + 1, 1, version.manifestId, 'dev', version.takenAt);
    for (const id of version.objects)
      store.db
        .prepare('INSERT OR IGNORE INTO checkpoint_objects VALUES (?,?,?)')
        .run('fixture', version.manifestId, id);
  }
  for (const id of input.available)
    store.db.prepare('INSERT INTO object_replicas VALUES (?,?)').run(id, 'replica');
  process.stdout.write(JSON.stringify(new Placement(store, nodes).newestComplete('fixture')));
} finally {
  store.db.close();
}
