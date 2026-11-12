import type { NodeLimits } from '../config';
import type { MetricsSample } from './metrics';

export function diskFloor(
  node: { limits: Pick<NodeLimits, 'diskReserveBytes'> },
  sample: MetricsSample,
): number {
  return node.limits.diskReserveBytes ?? Math.max(2 * 1024 ** 3, sample.value.disk.total * 0.05);
}
