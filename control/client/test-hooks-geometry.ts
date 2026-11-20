import { PresentationSession } from './presentation/presentation-session';

let presentation: PresentationSession | undefined;
const inputStates = new Map<string, string>();
function inputChanged(viewId: string, authority: ReturnType<PresentationSession['canInput']>) {
  const key = JSON.stringify(
    authority && [
      authority.layout.epoch,
      authority.layout.generation,
      authority.attempt,
      authority.surface.width,
      authority.surface.height,
      authority.pageHeight,
    ],
  );
  if (inputStates.get(viewId) === key) return;
  inputStates.set(viewId, key);
  window.dispatchEvent(new CustomEvent('remotekit-test-input', { detail: { at: performance.now() } }));
}
const canInput = PresentationSession.prototype.canInput;
PresentationSession.prototype.canInput = function (viewId) {
  presentation = this;
  const authority = canInput.call(this, viewId);
  inputChanged(viewId, authority);
  return authority;
};
const setTransitionBlocked = PresentationSession.prototype.setTransitionBlocked;
PresentationSession.prototype.setTransitionBlocked = function (viewId, blocked) {
  setTransitionBlocked.call(this, viewId, blocked);
  this.canInput(viewId);
};

let height: number | null = null;
let visual: VisualViewport | null = null;

export const geometryTest = {
  inspect() {
    const snapshot = presentation?.getSnapshot();
    return {
      snapshot,
      input: Object.fromEntries(
        (snapshot?.layout?.views ?? []).map((view) => [view.id, presentation?.canInput(view.id)]),
      ),
    };
  },
  occlude(bottom: number) {
    if (!visual) {
      visual = window.visualViewport;
      if (!visual) throw Error('visualViewport is required');
      const natural = Object.getOwnPropertyDescriptor(VisualViewport.prototype, 'height')!.get!;
      Object.defineProperty(visual, 'height', { get: () => height ?? natural.call(visual) });
    }
    height = bottom ? window.innerHeight - bottom : null;
    visual.dispatchEvent(new Event('resize'));
  },
};

import.meta.hot?.dispose(() => {
  PresentationSession.prototype.canInput = canInput;
  PresentationSession.prototype.setTransitionBlocked = setTransitionBlocked;
  if (visual) Reflect.deleteProperty(visual, 'height');
});
