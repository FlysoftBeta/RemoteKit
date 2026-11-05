import { AuthorizationScope } from './auth/authorization-scope';
import { ControlSession } from './control/control-session';
import { OperationsStore } from './control/operations-store';
import { ViewportRequests } from './control/viewport-requests';
import { WorkspaceSession } from './control/workspace-session';
import { EditingSession } from './editing/editing-session';
import { FileChannel } from './files/file-channel';
import { InputPipeline } from './input/input-pipeline';
import { TouchSession } from './input/touch-session';
import { MediaObservations } from './media/observations';
import { PresentationSession } from './presentation/presentation-session';
import { EndpointChannel } from './rtc/endpoint-channel';
import { RtcSession } from './rtc/rtc-session';
export class ViewerSession {
  readonly rtc: RtcSession;
  readonly presentation: PresentationSession;
  readonly input: InputPipeline;
  readonly touch: TouchSession;
  readonly observations: MediaObservations;
  readonly endpoint: EndpointChannel;
  readonly authorization: AuthorizationScope;
  readonly editing: EditingSession;
  readonly operations: OperationsStore;
  readonly files: FileChannel;
  readonly control: ControlSession;
  readonly workspace: WorkspaceSession;
  readonly viewport: ViewportRequests;
  constructor() {
    let rtc: RtcSession;
    let presentation: PresentationSession;
    let input: InputPipeline;
    let touch: TouchSession;
    let observations: MediaObservations;
    let endpoint: EndpointChannel;
    let authorization: AuthorizationScope;
    let editing: EditingSession;
    rtc = this.rtc = new RtcSession();
    presentation = this.presentation = new PresentationSession({
      get endpoint() {
        return endpoint;
      },
      get rtc() {
        return rtc;
      },
      get authorization() {
        return authorization;
      },
    });
    input = this.input = new InputPipeline({
      canInput: (view) => presentation.canInput(view),
      send: (message) => endpoint.send(message),
      layout: () => presentation.layout,
      attempt: () => rtc.attempt,
      scope: () => ({ locked: authorization.productLocked, epoch: authorization.peerAuthEpoch }),
      channel: () => endpoint.channel,
      inputStart: (at) => observations.latency.inputStart(at, performance.now(), Date.now()),
      report: (change) => observations.update(change),
      grantFocus: (id, token) => presentation.acceptFocus(id, token),
      clearEditing: () => editing.clear(),
      reconcileEditing: (views) => editing.reconcile(views),
    });
    touch = this.touch = new TouchSession();
    observations = this.observations = new MediaObservations({
      get rtc() {
        return rtc;
      },
      get authorization() {
        return authorization;
      },
      get presentation() {
        return presentation;
      },
      get endpoint() {
        return endpoint;
      },
      get input() {
        return input;
      },
    });
    endpoint = this.endpoint = new EndpointChannel({
      get authorization() {
        return authorization;
      },
    });
    authorization = this.authorization = new AuthorizationScope({
      get rtc() {
        return rtc;
      },
      get endpoint() {
        return endpoint;
      },
    });
    editing = this.editing = new EditingSession({
      get rtc() {
        return rtc;
      },
    });
    const files = (this.files = new FileChannel(
      () => (authorization.productLocked ? null : endpoint.channel),
      () => authorization.peerAuthEpoch,
    ));
    let workspace: WorkspaceSession;
    const control = (this.control = new ControlSession(
      (state) => workspace.acceptState(state),
      (status) => workspace.acceptStatus(status),
      (signal) => rtc.receiveServerSignal(signal),
      (auth) => workspace.acceptAuth(auth),
    ));
    const viewport = (this.viewport = new ViewportRequests((params) => control.request('viewport', params)));
    const operations = (this.operations = new OperationsStore({
      ready: () => authorization.productReady && control.getSnapshot().phase === 'online',
      send: (message) => endpoint.send(message),
      status: (operation) =>
        control.request('operation.status', {
          operationId: operation.operationId,
          operationGeneration: operation.operationGeneration,
        }),
    }));
    workspace = this.workspace = new WorkspaceSession({
      authorization,
      operations,
      rtc,
      control,
      viewport,
      setAudioChannels: (channels) => observations.audio.setChannels(channels),
    });
    rtc.setControlRpc((method, params) => control.request(method, params as never));

    operations.subscribe(workspace.operationsChanged);
    workspace.subscribe(workspace.availabilityChanged);
    authorization.subscribe(workspace.availabilityChanged);
    rtc.events.subscribe(authorization.onRtc);
    rtc.events.subscribe(endpoint.onRtc);
    rtc.events.subscribe(presentation.onRtc);
    rtc.events.subscribe(input.onRtc);
    rtc.events.subscribe(observations.onRtc);
    endpoint.events.subscribe(rtc.onChannel);
    endpoint.events.subscribe(authorization.onChannel);
    endpoint.events.subscribe(presentation.onChannel);
    endpoint.events.subscribe(input.onChannel);
    endpoint.events.subscribe(observations.onChannel);
    endpoint.events.subscribe(files.onChannel);
    endpoint.messages.subscribe(editing.handle.bind(editing));
    endpoint.messages.subscribe(presentation.handle.bind(presentation));
    endpoint.messages.subscribe(observations.handle.bind(observations));
    endpoint.messages.subscribe(input.handle.bind(input));
    endpoint.messages.subscribe(operations.handle.bind(operations));
    endpoint.messages.subscribe(files.handle.bind(files));
    presentation.subscribeFrames(input.flushFocusedInput.bind(input));
    presentation.observations.subscribe(observations.onPresentation);
    authorization.resets.subscribe(presentation.reset.bind(presentation));
    authorization.resets.subscribe(input.reset.bind(input));
    authorization.resets.subscribe(touch.reset.bind(touch));
    authorization.resets.subscribe(editing.reset.bind(editing));
    authorization.resets.subscribe(observations.resetMediaDiagnostics.bind(observations));
    authorization.resets.subscribe(operations.reset.bind(operations));
    authorization.resets.subscribe(files.disconnect.bind(files));
    authorization.transitions.subscribe(observations.onAuthorization);
    authorization.transitions.subscribe(presentation.onAuthorization);
    observations.onAuthorization();
  }
}
