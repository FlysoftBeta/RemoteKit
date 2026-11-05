export type AudioChannels = {
  left: boolean;
  right: boolean;
};
export type AudioPlaybackState = 'unavailable' | 'blocked' | 'playing';
// Alter only Opus fmtp in audio sections. Video/H264 negotiation stays untouched.
export function stereoOpusOffer(sdp: string): string {
  return sdp
    .split(/(?=^m=)/m)
    .map((section) => {
      if (!section.startsWith('m=audio ')) return section;
      const ids = [...section.matchAll(/^a=rtpmap:(\d+) opus\/48000(?:\/2)?\r?$/gim)].map((m) => m[1]);
      for (const id of ids) {
        const pattern = new RegExp('^a=fmtp:' + id + ' ([^\\r\\n]*)', 'm');
        const match = section.match(pattern);
        const params = (match?.[1] ?? '')
          .split(';')
          .map((p) => p.trim())
          .filter((p) => p && !/^(?:stereo|sprop-stereo)=/i.test(p));
        const line = `a=fmtp:${id} ${[...params, 'stereo=1', 'sprop-stereo=1'].join(';')}`;
        section = match
          ? section.replace(pattern, line)
          : section.replace(
              new RegExp('(^a=rtpmap:' + id + ' [^\\r\\n]*)(\\r?\\n)', 'm'),
              '$1$2' + line + '\r\n',
            );
      }
      return section;
    })
    .join('');
}
export class ViewerAudioOutput {
  state: AudioPlaybackState = 'unavailable';
  private context?: AudioContext;
  private source?: MediaStreamAudioSourceNode;
  private element?: HTMLAudioElement;
  private nodes: AudioNode[] = [];
  private gains: GainNode[] = [];
  private track?: MediaStreamTrack;
  private generation = 0;
  private muted = false;
  private channels: AudioChannels = { left: true, right: true };
  constructor(private changed: () => void) {}
  setChannels(channels: AudioChannels) {
    this.channels = { ...channels };
    this.gains.forEach((gain, index) => {
      gain.gain.value = !this.muted && (index ? channels.right : channels.left) ? 1 : 0;
    });
  }
  setMuted(muted: boolean) {
    this.muted = muted;
    this.setChannels(this.channels);
  }
  attach(track: MediaStreamTrack) {
    this.detach();
    this.track = track;
    const generation = this.generation;
    try {
      const Context = globalThis.AudioContext ?? (globalThis as any).webkitAudioContext;
      if (!Context) {
        this.changed();
        return;
      }
      const context: AudioContext = (this.context = new Context());
      // The zero-volume element activates Chromium's WebRTC remote playout
      // pull; PCM reaches WebAudio through the track source. In Chromium,
      // a MediaElementSource for srcObject can decode yet output silence.
      const element = (this.element = document.createElement('audio'));
      element.volume = 0;
      element.srcObject = new MediaStream([track]);
      element.setAttribute('playsinline', '');
      const source = (this.source = context.createMediaStreamSource(new MediaStream([track])));
      // Speaker interpretation upmixes mono equally before independently gating L/R.
      const stereo = context.createGain();
      stereo.channelCount = 2;
      stereo.channelCountMode = 'explicit';
      stereo.channelInterpretation = 'speakers';
      const split = context.createChannelSplitter(2),
        merge = context.createChannelMerger(2);
      this.gains = [context.createGain(), context.createGain()];
      source.connect(stereo);
      stereo.connect(split);
      this.gains.forEach((gain, index) => {
        split.connect(gain, index);
        gain.connect(merge, 0, index);
      });
      merge.connect(context.destination);
      this.nodes = [source, stereo, split, merge, ...this.gains];
      this.setChannels(this.channels);
      const update = () => {
        if (generation !== this.generation) return;
        this.state =
          track.readyState === 'ended'
            ? 'unavailable'
            : context.state === 'running' && !element.paused
              ? 'playing'
              : 'blocked';
        this.changed();
      };
      context.onstatechange = update;
      element.onplaying = update;
      element.onpause = update;
      track.onended = () => {
        if (generation === this.generation) this.detach();
      };
      update();
      void element
        .play()
        .then(update)
        .catch(() => {
          if (generation === this.generation) {
            this.state = 'blocked';
            this.changed();
          }
        });
    } catch {
      this.detach();
    }
  }
  // Call synchronously inside the user gesture, before any settings RPC awaits.
  resume() {
    const context = this.context,
      element = this.element,
      generation = this.generation;
    if (!context || !element) return;
    void Promise.all([context.resume(), element.play()])
      .then(() => {
        if (generation === this.generation) {
          this.state = context.state === 'running' && !element.paused ? 'playing' : 'blocked';
          this.changed();
        }
      })
      .catch(() => {
        if (generation === this.generation) {
          this.state = 'blocked';
          this.changed();
        }
      });
  }
  detach() {
    this.generation++;
    if (this.track) {
      this.track.onended = null;
      this.track.stop();
    }
    this.track = undefined;
    const element = this.element;
    this.element = undefined;
    if (element) {
      element.onplaying = element.onpause = null;
      element.pause();
      element.srcObject = null;
      element.remove();
    }
    for (const node of this.nodes) {
      try {
        node.disconnect();
      } catch {}
    }
    this.nodes = [];
    this.gains = [];
    this.source = undefined;
    const context = this.context;
    this.context = undefined;
    if (context) {
      context.onstatechange = null;
      void context.close().catch(() => {});
    }
    this.state = 'unavailable';
    this.changed();
  }
}
