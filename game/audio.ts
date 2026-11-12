/** The game's audio graph: a human voice engine (the beatboxer) and a creature engine (the beast), each in its own worklet node. */
import workletUrl from "./processor.ts?worker&url";
import { chimeraModule } from "../src/wasm/chimera.ts";
import type { TelemetryMessage } from "../src/worklet/protocol.ts";
import type { GameMsg, GameReply } from "./processor.ts";

export { workletUrl };

export class GameAudio {
  ctx: AudioContext | null = null;
  private voiceNode: AudioWorkletNode | null = null;
  private beastNode: AudioWorkletNode | null = null;
  private master: GainNode | null = null;
  private micIn: AudioNode | null = null;
  private micOn = false;
  scope: AnalyserNode | null = null;
  /** the voice's latest telemetry (the head is drawn from it) */
  latest: TelemetryMessage | null = null;
  beastLevel = 0;
  load = 0;
  beastLoad = 0;
  error: string | null = null;
  /** the player's timing correction (ms): positive when the sound reaches them late */
  offsetMs = 0;
  onBeatStart: ((time: number) => void) | null = null;
  private starting: Promise<void> | null = null;

  get started(): boolean {
    return !!this.voiceNode;
  }

  start(): Promise<void> {
    if (this.voiceNode && this.ctx) return this.ctx.resume();
    return (this.starting ??= this.build().finally(() => (this.starting = null)));
  }

  private async build(): Promise<void> {
    // 48 kHz whatever the device runs at: the airway's cost grows with the square of its rate
    const ctx = new AudioContext({ latencyHint: "interactive", sampleRate: 48000 });
    try {
      await ctx.audioWorklet.addModule(workletUrl);
      const make = (telemetry: boolean) =>
        new AudioWorkletNode(ctx, "chimera-game", { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2], processorOptions: { module: chimeraModule(), telemetry } });
      const voice = make(true);
      const beast = make(false);
      const master = ctx.createGain();
      master.gain.value = 0.85;
      // close-mic chain for the beatbox (as the app's): proximity bass, presence, a fast compressor
      const shelf = ctx.createBiquadFilter();
      shelf.type = "lowshelf";
      shelf.frequency.value = 120;
      shelf.gain.value = 9;
      const presence = ctx.createBiquadFilter();
      presence.type = "peaking";
      presence.frequency.value = 3500;
      presence.Q.value = 0.8;
      presence.gain.value = 3;
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -28;
      comp.knee.value = 8;
      comp.ratio.value = 5;
      comp.attack.value = 0.002;
      comp.release.value = 0.12;
      const makeup = ctx.createGain();
      makeup.gain.value = 2.2;
      shelf.connect(presence).connect(comp).connect(makeup).connect(master);
      voice.connect(master);
      const beastGain = ctx.createGain();
      beastGain.gain.value = 0.7;
      beast.connect(beastGain).connect(master);
      const scope = ctx.createAnalyser();
      scope.fftSize = 2048;
      master.connect(ctx.destination);
      master.connect(scope);
      voice.port.onmessage = (e: MessageEvent<GameReply>) => {
        const m = e.data;
        if (m.type === "telemetry") {
          this.latest = m;
          this.load = m.load;
        } else if (m.type === "beatStart") this.onBeatStart?.(m.time);
        else if (m.type === "error") this.error = m.message;
      };
      beast.port.onmessage = (e: MessageEvent<GameReply>) => {
        const m = e.data;
        if (m.type === "level") {
          this.beastLevel = m.rms;
          this.beastLoad = m.load;
        } else if (m.type === "error") this.error = m.message;
      };
      this.ctx = ctx;
      this.voiceNode = voice;
      this.beastNode = beast;
      this.master = master;
      this.micIn = shelf;
      this.scope = scope;
      await ctx.resume();
    } catch (e) {
      void ctx.close().catch(() => {});
      throw e;
    }
  }

  voice(m: GameMsg): void {
    this.voiceNode?.port.postMessage(m);
  }

  beast(m: GameMsg): void {
    this.beastNode?.port.postMessage(m);
  }

  /** Route the voice through the close-mic chain (the beat) or straight out (speech). */
  setMic(on: boolean): void {
    if (on === this.micOn || !this.voiceNode || !this.master || !this.micIn) return;
    this.micOn = on;
    this.voiceNode.disconnect();
    this.voiceNode.connect(on ? this.micIn : this.master);
  }

  /**
   * The context time of the sound reaching the player's ears at `perf` (a performance.now() or
   * event timestamp): what a key press is judged against.
   */
  heard(perf: number = performance.now()): number {
    const c = this.ctx;
    if (!c) return 0;
    if (Math.abs(perf - performance.now()) > 250) perf = performance.now();
    const ts = typeof c.getOutputTimestamp === "function" ? c.getOutputTimestamp() : null;
    let t: number;
    if (ts && ts.performanceTime && ts.contextTime) t = ts.contextTime + (perf - ts.performanceTime) / 1000;
    else t = c.currentTime - (c.outputLatency || 0) - (c.baseLatency || 0);
    return t - this.offsetMs / 1000;
  }
}
