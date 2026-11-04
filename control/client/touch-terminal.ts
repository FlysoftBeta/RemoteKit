import type { InputResult } from './transport';
import type { Surface } from './types';
import type { TouchPacket } from './touch-input';

export interface TouchOwner { surface: Surface; identity: string; packet: TouchPacket }
// Sent request identity includes connection attempt, layout and focus ownership.
// A server failure alone is never evidence that the remote owner was retired.
export function touchTerminalResult(owner: TouchOwner, result: InputResult, currentIdentity: string | undefined, contactCount: number): 'invalidated' | 'processed' | undefined {
  if (currentIdentity !== owner.identity || result.identity !== owner.identity ||
      result.surface.session !== owner.surface.session || result.surface.id !== owner.surface.id ||
      result.surface.instance !== owner.surface.instance || result.surface.document !== owner.surface.document ||
      result.event.type !== 'touch' || result.event.sequenceId !== owner.packet.sequenceId) return;
  if (!result.ok && result.touchState === 'terminal-invalidated' && result.touchSequenceId === owner.packet.sequenceId) return 'invalidated';
  if (!result.ok || result.event !== owner.packet ||
      (result.event.action !== 'cancel' && (result.event.action !== 'end' || contactCount !== 0))) return;
  if (result.touchState === 'processed' && result.touchSequenceId === owner.packet.sequenceId) return 'processed';
  if (!result.touchState && owner.packet.gestureMode !== 'client-v1') return 'processed';
}
