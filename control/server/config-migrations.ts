export interface ConfigMigration {
  version: number;
  up(value: unknown): unknown;
}
export const configMigrations: Readonly<
  Record<'control' | 'node' | 'key' | 'manager', readonly ConfigMigration[]>
> = {
  control: [],
  node: [],
  key: [],
  manager: [],
};
export function migrateConfig(store: keyof typeof configMigrations, value: unknown): unknown {
  let current = value;
  for (const step of configMigrations[store]) {
    if (
      current &&
      typeof current === 'object' &&
      'version' in current &&
      current.version === step.version - 1
    )
      current = step.up(current);
  }
  return current;
}
