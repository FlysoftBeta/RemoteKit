/**
 * An occlusion revision is a decimal u64 `(viewerGeneration << 32) | seq`.
 * Control assigns the generation per Viewer attach; the Viewer counts seq within it.
 */
export const VIEWER_GENERATION_MAX = 0xffffffff;
export const OCCLUSION_SEQUENCE_MAX = 0xffffffff;

export function occlusionRevision(generation: number, sequence: number): string {
  return ((BigInt(generation) << 32n) | BigInt(sequence)).toString();
}

export function splitOcclusionRevision(revision: string): { generation: number; sequence: number } {
  const value = BigInt(revision);
  return { generation: Number(value >> 32n), sequence: Number(value & 0xffffffffn) };
}
