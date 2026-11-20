import './lock-screen.css';
import { useCallback, useEffect, useRef, useState } from 'react';
import { parseWireError, RemoteKitError } from '../../shared/errors';
import type { AuthState } from '../../shared/security';
import { failureError } from '../failures';
import type { AuthCamera } from './auth-camera';

export type FacePhase = 'idle' | 'scanning' | 'failed';
type Attempt =
  | { kind: 'idle' }
  | { kind: 'starting'; previous?: string }
  | { kind: 'scanning'; challengeId: string }
  | { kind: 'failed'; error?: RemoteKitError };

const finished = new Set(['failed', 'expired', 'absent']);

// One verify attempt as the lock screen shows it. Automatic verification (camera already granted)
// shows as scanning too; an attempt that ends without unlocking stays failed until the user retries.
export function useFaceUnlock(auth: AuthState | null, camera: AuthCamera) {
  const [attempt, setAttempt] = useState<Attempt>({ kind: 'idle' });
  const starting = useRef(false);
  const face = auth?.face;
  const usable = !!auth?.locked && auth.methods.face && !!face?.available;
  useEffect(() => {
    if (!face) return;
    const verify = face.purpose === 'verify';
    setAttempt((current) => {
      if (verify && face.status === 'pending' && face.challengeId)
        return current.kind === 'scanning' && current.challengeId === face.challengeId
          ? current
          : { kind: 'scanning', challengeId: face.challengeId };
      const ended = verify && finished.has(face.status ?? '');
      const error = face.error ? parseWireError(face.error) : undefined;
      if (current.kind === 'scanning' && face.status !== 'matched') return { kind: 'failed', error };
      if (current.kind === 'starting' && ended && face.challengeId !== current.previous)
        return { kind: 'failed', error };
      return current;
    });
  }, [face?.purpose, face?.status, face?.challengeId, face?.error]);
  useEffect(() => {
    if (attempt.kind === 'starting' && camera.explicit !== 'verify') setAttempt({ kind: 'idle' });
  }, [attempt.kind, camera.explicit]);
  useEffect(() => {
    const hidden = () => {
      if (document.hidden) setAttempt({ kind: 'idle' });
    };
    document.addEventListener('visibilitychange', hidden);
    return () => document.removeEventListener('visibilitychange', hidden);
  }, []);
  const begin = useCallback(() => {
    if (
      !usable ||
      starting.current ||
      attempt.kind === 'starting' ||
      attempt.kind === 'scanning' ||
      (face?.purpose === 'verify' && face.status === 'pending')
    )
      return;
    starting.current = true;
    setAttempt({ kind: 'starting', previous: face?.challengeId });
    camera
      .start('verify')
      .catch((error) => setAttempt({ kind: 'failed', error: failureError(error) }))
      .finally(() => {
        starting.current = false;
      });
  }, [usable, face?.challengeId, face?.purpose, face?.status, camera, attempt.kind]);
  const stop = useCallback(() => {
    if (camera.explicit === 'verify') camera.cancel();
    setAttempt({ kind: 'idle' });
  }, [camera]);
  const phase: FacePhase =
    attempt.kind === 'starting' || attempt.kind === 'scanning' ? 'scanning' : attempt.kind;
  const reason =
    attempt.kind !== 'failed'
      ? undefined
      : attempt.error?.code === 'forbidden'
        ? '未获得摄像头权限'
        : attempt.error?.code === 'unavailable' || face?.outcome === 'camera_unavailable'
          ? '摄像头不可用'
          : '未能识别';
  return { usable, enrolled: !!auth?.methods.face, phase, reason, begin, stop };
}
export type FaceUnlock = ReturnType<typeof useFaceUnlock>;

function FaceGlyph({ phase }: { phase: FacePhase }) {
  return (
    <svg className="lock-face-glyph" viewBox="0 0 48 48" aria-hidden>
      <g className="lock-face-frame">
        <path d="M4 15V9a5 5 0 0 1 5-5h6" />
        <path d="M33 4h6a5 5 0 0 1 5 5v6" />
        <path d="M44 33v6a5 5 0 0 1-5 5h-6" />
        <path d="M15 44H9a5 5 0 0 1-5-5v-6" />
      </g>
      <path d="M17 17v4M31 17v4M24 18v8h-2" />
      <path d={phase === 'failed' ? 'M18 33h12' : 'M17.5 31.5q6.5 5 13 0'} />
      {phase === 'scanning' && <rect className="lock-face-scan" x="8" y="8" width="32" height="2" rx="1" />}
    </svg>
  );
}

export function FaceBadge({ face, prominent }: { face: FaceUnlock; prominent?: boolean }) {
  const caption =
    face.phase === 'scanning'
      ? '正在识别…'
      : face.phase === 'failed'
        ? `${face.reason}，点按重试`
        : '点按使用人脸解锁';
  return (
    <button
      type="button"
      className={`lock-face ${prominent ? 'prominent' : 'quiet'} ${face.phase}`}
      aria-label={caption}
      aria-busy={face.phase === 'scanning'}
      onClick={(event) => {
        event.stopPropagation();
        if (face.phase !== 'scanning') face.begin();
      }}
    >
      <span className="lock-face-mark">
        <FaceGlyph phase={face.phase} />
      </span>
      {prominent && (
        <span className="lock-face-caption" role="status">
          {caption}
        </span>
      )}
    </button>
  );
}
