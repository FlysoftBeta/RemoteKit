import type { NodeConfig } from '../config';
import type { MetricsSample } from './metrics';

export function diskFloor(
  node: { config: Pick<NodeConfig, 'diskReserveBytes'> },
  sample: MetricsSample,
): number {
  return node.config.diskReserveBytes ?? Math.max(2 * 1024 ** 3, sample.value.disk.total * 0.05);
}
