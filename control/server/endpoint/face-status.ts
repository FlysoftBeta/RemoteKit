import { faceHints, type FacePurpose } from '../../shared/security';
import { array, literal, number, object, string, type Codec } from '../persistence/codec';
import { wireError } from '../persistence/documents';
import { faceTemplate } from '../persistence/sealed-documents';
import type { FaceStatusReply, NativeError } from './types';

const nativeError: Codec<NativeError> = {
  read(value, path) {
    const { reason, ...error } = wireError.read(value, path);
    if (reason === 'session_bound_node_offline') throw new Error(`${path} expected native error reason`);
    return { ...error, reason };
  },
};

const reply = object(
  {
    challengeId: string(),
    status: literal('pending', 'matched', 'enrolled', 'absent', 'failed', 'expired'),
  },
  {
    templates: array(faceTemplate, { min: 3, max: 5 }),
    learn: faceTemplate,
    progress: number({ min: 0, max: 1 }),
    hint: literal(...faceHints),
    error: nativeError,
    outcome: literal('no_matching_face', 'camera_unavailable'),
  },
);

export function readFaceStatus(value: unknown, purpose: FacePurpose, challengeId: string): FaceStatusReply {
  const result = reply.read(value, 'faceStatus');
  const enrolling = purpose === 'enroll';
  const collecting = enrolling && result.status === 'pending';
  const enrolled = enrolling && result.status === 'enrolled';
  if (
    result.challengeId !== challengeId ||
    (result.status === 'enrolled' && !enrolling) ||
    (result.status === 'matched' && enrolling) ||
    (result.status === 'absent' && purpose !== 'presence') ||
    (result.templates !== undefined) !== enrolled ||
    (result.progress !== undefined) !== collecting ||
    (result.hint !== undefined && !collecting) ||
    (result.learn !== undefined && (purpose !== 'verify' || !['pending', 'matched'].includes(result.status)))
  )
    throw new Error('Invalid faceStatus fields for challenge');
  return result;
}
