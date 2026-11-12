import { linkSync, mkdirSync, readdirSync, existsSync, unlinkSync, symlinkSync } from 'node:fs';
import { basename, dirname, join, resolve, extname } from 'node:path';
export function stageRuntime(endpoint, browser, destination) {
  const target = resolve(destination);
  if ([dirname(resolve(endpoint)), dirname(resolve(browser))].includes(target))
    throw Error('Runtime destination must differ from source');
  mkdirSync(target, { recursive: true });
  for (const source of [dirname(resolve(browser)), dirname(resolve(endpoint))]) {
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      if (
        entry.isDirectory()
          ? !['locales', 'hyphen-data'].includes(entry.name)
          : !(
              ['.dll', '.pak', '.dat', '.bin'].includes(extname(entry.name).toLowerCase()) ||
              [
                basename(endpoint),
                basename(browser),
                'remotekit_node.exe',
                'vk_swiftshader_icd.json',
              ].includes(entry.name)
            )
      )
        continue;
      const output = join(target, entry.name);
      if (existsSync(output)) {
        if (entry.isDirectory()) continue;
        unlinkSync(output);
      }
      if (entry.isDirectory()) symlinkSync(join(source, entry.name), output, 'junction');
      else linkSync(join(source, entry.name), output);
    }
  }
  const executable = join(target, 'endpoint_service.exe');
  if (basename(endpoint) !== 'endpoint_service.exe') {
    if (existsSync(executable)) unlinkSync(executable);
    linkSync(resolve(endpoint), executable);
  }
  return executable;
}
