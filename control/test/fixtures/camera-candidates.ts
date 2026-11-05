export interface CameraCandidate {
  id: number;
  at: number;
  score: number;
  width: number;
  height: number;
  blob: Blob;
}
export const cameraBudget = {
  maxCandidates: 3,
  maxPixels: 12 * 1024 * 1024,
  maxFramePixels: 4 * 1024 * 1024,
  samples: 6,
  durationMs: 600,
  minimumSpacingMs: 80,
} as const;
// Immutable Blob owns the very snapshot used for scoring; no video-frame resampling.
export class CameraCandidatePool {
  candidates: CameraCandidate[] = [];
  offer(candidate: CameraCandidate) {
    const pixels = candidate.width * candidate.height;
    if (!Number.isFinite(candidate.score) || pixels <= 0 || pixels > cameraBudget.maxFramePixels) return;
    const near = this.candidates.find(
      (existing) => Math.abs(existing.at - candidate.at) < cameraBudget.minimumSpacingMs,
    );
    if (near && near.score >= candidate.score) return;
    this.candidates = this.candidates.filter((existing) => existing !== near);
    this.candidates.push(candidate);
    this.candidates.sort((a, b) => b.score - a.score || a.at - b.at);
    let retained = 0;
    this.candidates = this.candidates.filter((entry, index) => {
      retained += entry.width * entry.height;
      return index < cameraBudget.maxCandidates && retained <= cameraBudget.maxPixels;
    });
  }
  clear() {
    this.candidates = [];
  }
}
