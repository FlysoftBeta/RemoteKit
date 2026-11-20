import type { WireError } from './errors';
import type { ProductUser } from './product';

export const DEFAULT_IDLE_SECONDS = 300;

export interface AuthSettings {
  lockOnHidden: boolean;
  lockOnIdle: boolean;
  idleSeconds: number;
  lockOnDeparture: boolean;
  faceEnabled: boolean;
}

export type FacePurpose = 'enroll' | 'verify' | 'presence';
export type FaceStatus = 'pending' | 'matched' | 'enrolled' | 'absent' | 'failed' | 'expired';
export const faceHints = [
  'no_face',
  'multiple_faces',
  'too_far',
  'too_dark',
  'too_bright',
  'backlit',
  'blurry',
  'turn_head',
] as const;
export type FaceHint = (typeof faceHints)[number];

export interface AuthState {
  user: ProductUser;
  locked: boolean;
  epoch: number;
  peerEpoch: number;
  serviceEpoch: number;
  methods: { password: true; pin: boolean; face: boolean };
  settings: AuthSettings;
  face: {
    available: boolean;
    enrolled: boolean;
    reason?: string;
    outcome?: 'no_matching_face' | 'camera_unavailable';
    error?: WireError;
    challengeId?: string;
    purpose?: FacePurpose;
    status?: FaceStatus;
    progress?: number;
    hint?: FaceHint;
  };
  endpointGeneration: number;
}

export interface AuthSocketMethods {
  'auth.get': { params: Record<string, never>; result: AuthState };
  'auth.lock': { params: Record<string, never>; result: AuthState };
  'auth.verify': { params: { method: 'password' | 'pin'; secret: string }; result: AuthState };
  'auth.settings': {
    params: { currentPassword: string; settings?: Partial<AuthSettings>; pin?: string | null };
    result: AuthState;
  };
  'auth.password': { params: { currentPassword: string; newPassword: string }; result: AuthState };
  'auth.face.begin': { params: { purpose: FacePurpose; currentPassword?: string }; result: AuthState };
  'auth.face.cancel': { params: { challengeId: string }; result: AuthState };
  'auth.face.remove': { params: { currentPassword: string }; result: AuthState };
}

export type AuthMessage = { type: 'auth'; auth: AuthState };
