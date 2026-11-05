import { InputPipeline } from '../client/input/input-pipeline';
import { TouchSession } from '../client/input/touch-session';
import { EditingSession } from '../client/editing/editing-session';
import { EndpointChannel } from '../client/rtc/endpoint-channel';
import type { Layout } from '../client/presentation/types';
import type { Diagnostics } from '../client/media/types';

export function inputFixture() {
  const rtc = { attempt: 0, peer: undefined as unknown };
  const authorization = { productLocked: false, peerAuthEpoch: undefined as number | undefined };
  const presentation = {
    layout: null as Layout | null,
    canInput: (_view: string) => true,
    displayReady: false,
  };
  const observations = {
    diagnostics: { connection: '', channel: '' } as Diagnostics,
    update(change: Partial<Diagnostics>) {
      this.diagnostics = { ...this.diagnostics, ...change };
    },
  };
  const editing = new EditingSession({ rtc });
  const endpoint = new EndpointChannel({ authorization });
  let touch: TouchSession;
  const input = new InputPipeline({
    canInput: (id) => {
      const surface = presentation.layout?.views.find((view) => view.id === id);
      return presentation.canInput(id) && surface && presentation.layout
        ? { surface, layout: presentation.layout, attempt: rtc.attempt }
        : null;
    },
    send: (message) => endpoint.send(message),
    layout: () => presentation.layout,
    attempt: () => rtc.attempt,
    scope: () => ({ locked: authorization.productLocked, epoch: authorization.peerAuthEpoch }),
    channel: () => endpoint.channel,
    inputStart: () => undefined,
    report: (change) => observations.update(change),
    grantFocus: (id, token) => {
      const view = presentation.layout?.views.find((view) => view.id === id);
      if (view) view.focus = token;
    },
    clearEditing: () => editing.clear(),
    reconcileEditing: (views) => editing.reconcile(views),
    get terminals() {
      return touch;
    },
  });
  touch = new TouchSession({
    queuedTerminalCount: () => input.queuedTerminalCount(),
    nextSequence: () => input.nextSequence(),
    identity: (surface) => input.inputIdentity(surface),
    report: (request, phase, sequence, reason) => input.reportInputDelivery(request, phase, sequence, reason),
    layout: () => presentation.layout,
    scope: () => ({ locked: authorization.productLocked, epoch: authorization.peerAuthEpoch }),
    attempt: () => rtc.attempt,
    channel: () => endpoint.channel,
    send: (message) => endpoint.send(message),
  });
  endpoint.events.subscribe((event) => {
    if (event.type === 'writable') input.drainInput();
  });
  endpoint.messages.subscribe((message) => {
    if (message.type === 'layout') {
      presentation.layout = message;
      input.layoutChanged();
    }
    editing.handle(message);
    input.handle(message);
  });
  return { input, touch, editing, presentation, endpoint, authorization, observations, rtc };
}

export function productSnapshot(): import('../shared/product').ProductState {
  return {
    serverIncarnation: 'server',
    snapshotSequence: 1,
    operationGeneration: 'generation',
    user: { id: 'user-id', username: 'viewer', isAdmin: false },
    workspace: {
      tenantId: 'tenant-id',
      revision: 0,
      layoutMode: 'focused',
      settings: {
        searchEngine: 'google',
        qualityPreference: 'auto',
        clientScaleOverride: null,
        memorySaverEnabled: true,
        showStats: false,
        autoFullscreen: false,
        audioChannels: { left: true, right: true },
      },
      sites: {},
      windows: [],
      tabs: [],
      activeWindowId: null,
    },
    pageDialogs: [],
    fileRequests: [],
    quality: {
      resourceLimitation: null,
      mode: 'product',
      preference: 'auto',
      clientScale: 1,
      effectiveDpr: 1,
      requested: { degradationPreference: 'balanced', maxFps: 60 },
      applied: null,
      estimatedLatencyMs: null,
      clockUncertaintyMs: null,
      feedbackStatus: 'unknown',
      reason: '',
    },
    endpointGeneration: 1,
    endpointError: null,
    viewer: { connected: true },
    integrations: { siteUa: false, lifecycle: false, popupAdoption: false },
    constraints: { clientScaleMin: 1, clientScaleMax: 2 },
  };
}
