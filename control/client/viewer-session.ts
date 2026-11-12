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
  readonly serviceRtc: RtcSession;
  readonly serviceEndpoint: EndpointChannel;
  readonly pageFiles: FileChannel;
  readonly libraryFiles;
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
    const serviceRtc = (this.serviceRtc = new RtcSession('service'));
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
      get endpoint() {
        return endpoint;
      },
    });
    editing = this.editing = new EditingSession({
      get rtc() {
        return rtc;
      },
    });
    const serviceEndpoint = (this.serviceEndpoint = new EndpointChannel({
      authorization: {
        get productLocked() {
          return authorization.productLocked;
        },
        get peerAuthEpoch() {
          return authorization.serviceAuthEpoch;
        },
      },
    }));
    const files = (this.files = new FileChannel(
      () => (authorization.productLocked ? null : serviceEndpoint.channel),
      () => authorization.serviceAuthEpoch,
    ));
    const pageFiles = (this.pageFiles = new FileChannel(
      () => (authorization.browserReady ? endpoint.channel : null),
      () => authorization.peerAuthEpoch,
      'page',
    ));
    this.libraryFiles = Object.assign(files, {
      photoThumbnail: files.photoThumbnail.bind(files),
      uploadAsset: files.uploadAsset.bind(files),
      processPhoto: files.processPhoto.bind(files),
      commitSelection: pageFiles.commitSelection.bind(pageFiles),
      cancelSelection: pageFiles.cancelSelection.bind(pageFiles),
    });
    let workspace: WorkspaceSession;
    const control = (this.control = new ControlSession(
      (state) => workspace.acceptState(state),
      (status) => workspace.acceptStatus(status),
      (signal) => {
        rtc.receiveServerSignal(signal);
        serviceRtc.receiveServerSignal(signal);
      },
      (auth) => workspace.acceptAuth(auth),
    ));
    const viewport = (this.viewport = new ViewportRequests((params) => control.request('viewport', params)));
    const operations = (this.operations = new OperationsStore({
      ready: () => workspace.shellReady,
      submit: (operation) => control.request('operation.submit', operation),
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
      serviceRtc,
      control,
      viewport,
      setAudioChannels: (channels) => observations.audio.setChannels(channels),
    });
    rtc.setControlRpc((method, params) => control.request(method, params as never));
    serviceRtc.setControlRpc((method, params) => control.request(method, params as never));
    serviceRtc.events.subscribe(authorization.onServiceRtc);
    serviceRtc.events.subscribe(serviceEndpoint.onRtc);
    serviceEndpoint.events.subscribe(serviceRtc.onChannel);
    serviceEndpoint.events.subscribe(authorization.onChannel);
    serviceEndpoint.events.subscribe(files.onChannel);
    serviceEndpoint.messages.subscribe(files.handle.bind(files));

    operations.subscribe(workspace.operationsChanged);
    rtc.subscribe(workspace.operationsChanged);
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
    endpoint.events.subscribe(pageFiles.onChannel);
    endpoint.messages.subscribe(editing.handle.bind(editing));
    endpoint.messages.subscribe(presentation.handle.bind(presentation));
    endpoint.messages.subscribe(observations.handle.bind(observations));
    endpoint.messages.subscribe(input.handle.bind(input));
    endpoint.messages.subscribe(pageFiles.handle.bind(pageFiles));
    presentation.subscribeFrames(input.flushFocusedInput.bind(input));
    presentation.observations.subscribe(observations.onPresentation);
    authorization.resets.subscribe(presentation.reset.bind(presentation));
    authorization.resets.subscribe(input.reset.bind(input));
    authorization.resets.subscribe(touch.reset.bind(touch));
    authorization.resets.subscribe(editing.reset.bind(editing));
    authorization.resets.subscribe(observations.resetMediaDiagnostics.bind(observations));
    authorization.transitions.subscribe(({ locked }) => {
      if (locked) operations.reset();
    });
    authorization.resets.subscribe(pageFiles.disconnect.bind(pageFiles));
    authorization.transitions.subscribe(({ locked }) => {
      if (locked) files.disconnect();
    });
    authorization.transitions.subscribe(observations.onAuthorization);
    authorization.transitions.subscribe(presentation.onAuthorization);
    observations.onAuthorization();
  }
}
