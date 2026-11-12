/**
 * The game's AudioWorklet processor: one CHIMERA engine (wasm) per node. Like src/worklet/processor.ts,
 * but every message is applied at the top of the next render quantum, where `currentTime` is exact,
 * so the main thread learns the context time of the sequencer's first hit and can judge key presses
 * against the beat it hears.
 */
import { writeGestures, writeSteps, fromUtf8, utf8, CONTROL_KEYS } from "../src/wasm/wire.ts";
import type { BodyMix, Gesture, HumanArtic, VoiceSource, BeatStep } from "../src/wasm/types.ts";
import type { TelemetryMessage } from "../src/worklet/protocol.ts";

declare const sampleRate: number;
declare const currentTime: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor(options?: unknown);
}

export type GameMsg =
  | { type: "artic"; values: Partial<HumanArtic> }
  | { type: "source"; values: Partial<VoiceSource> }
  | { type: "schedule"; gestures: Gesture[]; replace: boolean; lead?: number }
  | { type: "stopSpeech" }
  | { type: "beat"; steps?: (BeatStep | null)[]; bpm?: number; swing?: number; playing?: boolean }
  | { type: "beatHit"; id: string; note?: number; accent?: number }
  | { type: "creature"; id: string; params?: Record<string, number> }
  /** `hold`: how long the creature's engine stays awake for this call (s); it sleeps (costs nothing) otherwise */
  | { type: "call"; id: string; pitch?: number; amp?: number; hold?: number }
  | { type: "stopCall" }
  | { type: "telemetry"; enabled: boolean };

export type GameReply =
  | { type: "ready"; sampleRate: number }
  /** the sequencer started: context time at which step 0 sounds */
  | { type: "beatStart"; time: number }
  | TelemetryMessage
  | { type: "level"; rms: number; load: number }
  | { type: "error"; message: string };

type Fn = (...a: number[]) => number;
type Exports = { memory: WebAssembly.Memory } & Record<string, Fn>;

const ARTIC_KEYS = CONTROL_KEYS.slice(0, 17);
const SOURCE_KEYS = ["f0", "glide", "pressure", "breathiness", "tension", "fry", "roughness", "vibratoDepth", "vibratoRate", "drift", "voiced", "brightness"];
const TELE_HEADER = 16;
/** the sequencer schedules a step this long before its hit (BeatPlayer::HORIZON); step 0 sounds this long after start */
const HORIZON = 0.2;

interface CreatureInfo {
  id: string;
  params: string[];
  calls: string[];
}

class GameProcessor extends AudioWorkletProcessor {
  private readonly x: Exports;
  private readonly h: number;
  private failed = false;
  private telemetryOn: boolean;
  private blocks = 0;
  private load = 0;
  private creature: CreatureInfo | null = null;
  private readonly inbox: GameMsg[] = [];
  /** a creature's engine renders only until this context time: between calls it is silent anyway */
  private awakeUntil = 0;

  constructor(options: { processorOptions: { module: WebAssembly.Module; telemetry: boolean } }) {
    super();
    this.x = new WebAssembly.Instance(options.processorOptions.module, {}).exports as unknown as Exports;
    this.h = this.x.engine_new(sampleRate);
    this.telemetryOn = options.processorOptions.telemetry;
    this.port.onmessage = (e: MessageEvent<GameMsg>) => void this.inbox.push(e.data);
    this.post({ type: "ready", sampleRate });
  }

  private post(msg: GameReply): void {
    this.port.postMessage(msg);
  }

  private fail(err: unknown): void {
    if (this.failed) return;
    this.failed = true;
    this.post({ type: "error", message: `engine stopped: ${String(err)}` });
  }

  private get mem(): ArrayBuffer {
    return this.x.memory.buffer;
  }

  private values(): Float64Array {
    return new Float64Array(this.mem, this.x.engine_values(this.h), 32).fill(NaN);
  }

  private handle(m: GameMsg): void {
    const x = this.x, h = this.h;
    switch (m.type) {
      case "artic": {
        const v = this.values();
        for (const [k, val] of Object.entries(m.values)) {
          const i = ARTIC_KEYS.indexOf(k as never);
          if (i >= 0 && typeof val === "number") v[i] = val;
        }
        x.engine_set_artic(h, 2);
        break;
      }
      case "source": {
        const v = this.values();
        for (const [k, val] of Object.entries(m.values)) {
          const i = SOURCE_KEYS.indexOf(k);
          if (i >= 0) v[i] = typeof val === "boolean" ? (val ? 1 : 0) : (val as number);
        }
        x.engine_set_source(h);
        break;
      }
      case "schedule": {
        const n = writeGestures(this.mem, x.engine_records(h), m.gestures, 4000);
        x.engine_schedule(h, n, m.lead ?? 0.03, m.replace ? 1 : 0);
        break;
      }
      case "stopSpeech":
        x.engine_stop_speech(h);
        break;
      case "beat": {
        const n = m.steps ? writeSteps(this.mem, x.engine_records(h), m.steps) : 0;
        x.engine_set_beat(h, m.steps ? 1 : 0, n, m.bpm ?? NaN, m.swing ?? NaN, m.playing === undefined ? 2 : m.playing ? 1 : 0);
        if (m.playing) this.post({ type: "beatStart", time: currentTime + HORIZON });
        break;
      }
      case "beatHit":
        writeSteps(this.mem, x.engine_records(h), [{ id: m.id, note: m.note, accent: m.accent }]);
        x.engine_beat_hit(h);
        break;
      case "creature": {
        if (m.id === "human") {
          x.engine_set_human(h);
          this.creature = null;
          break;
        }
        const bytes = utf8(JSON.stringify({ id: m.id, params: m.params ?? {} }));
        const p = x.chimera_alloc(bytes.length);
        new Uint8Array(this.mem, p, bytes.length).set(bytes);
        const status = x.engine_set_creature(h, p, bytes.length);
        x.chimera_free(p, bytes.length);
        const v = JSON.parse(fromUtf8(new Uint8Array(this.mem, x.chimera_result_ptr(), x.chimera_result_len())));
        if (status !== 0) throw new Error(v.error);
        this.creature = v as CreatureInfo;
        break;
      }
      case "call": {
        const i = this.creature ? this.creature.calls.indexOf(m.id) : -1;
        if (i >= 0) {
          x.engine_play_call(h, i, m.pitch ?? NaN, m.amp ?? NaN);
          this.awakeUntil = currentTime + (m.hold ?? 3);
        }
        break;
      }
      case "stopCall":
        x.engine_stop_call(h);
        break;
      case "telemetry":
        this.telemetryOn = m.enabled;
        break;
    }
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    if (!out || out.length === 0) return true;
    const ch0 = out[0];
    if (this.failed) {
      for (const ch of out) ch.fill(0);
      return true;
    }
    const t0 = Date.now();
    let rms = 0;
    try {
      while (this.inbox.length) this.handle(this.inbox.shift()!);
      if (this.creature && currentTime > this.awakeUntil) ch0.fill(0);
      else {
        const p = this.x.engine_render(this.h, ch0.length);
        ch0.set(new Float32Array(this.mem, p, ch0.length));
        for (let i = 0; i < ch0.length; i++) rms += ch0[i] * ch0[i];
        rms = Math.sqrt(rms / ch0.length);
      }
    } catch (err) {
      ch0.fill(0);
      this.fail(err);
    }
    for (let c = 1; c < out.length; c++) out[c].set(ch0);
    const budget = (ch0.length / sampleRate) * 1000;
    this.load += 0.05 * ((Date.now() - t0) / budget - this.load);
    if (!this.failed && ++this.blocks % 6 === 0) {
      try {
        if (this.creature || !this.telemetryOn) this.post({ type: "level", rms, load: this.load });
        else this.post(this.humanTelemetry());
      } catch (err) {
        this.fail(err);
      }
    }
    return true;
  }

  private body(): BodyMix {
    return { female: this.x.engine_body_female(this.h), child: this.x.engine_body_child(this.h) };
  }

  /** The human voice's telemetry block → the message the head renderer reads (as src/worklet/processor.ts). */
  private humanTelemetry(): TelemetryMessage {
    const x = this.x, h = this.h;
    const p = x.engine_telemetry(h);
    const [phLen, orLen, velumPort, f0, voicing, pLung, outRms, noiseLevel, noiseNode, gate, clock, nArtic, nPh, nOr, nScope, nActive] = new Float64Array(this.mem, p, TELE_HEADER);
    const all = new Float64Array(this.mem, p, TELE_HEADER + nArtic + 3 * (nPh + nOr) + 2 * nScope);
    let o = TELE_HEADER;
    const take = (n: number) => Float32Array.from(all.subarray(o, (o += n)));
    const artic = take(nArtic), phAreas = take(nPh), orAreas = take(nOr), pressureRms = take(nPh + nOr), flow = take(nPh + nOr), glottalArea = take(nScope), glottalFlow = take(nScope);
    const labels = new Uint8Array(this.mem, x.engine_tele_labels(h), 4 * 25);
    const active: string[] = [];
    for (let i = 0; i < nActive; i++) active.push(fromUtf8(labels.subarray(i * 25 + 1, i * 25 + 1 + labels[i * 25])));
    return {
      type: "telemetry",
      t: { artic, phAreas, orAreas, phLen, orLen, pressureRms, flow, velumPort, glottalArea, glottalFlow, f0, voicing, pLung, outRms, noiseLevel, noiseNode, gate, clock, active },
      load: this.load,
      body: this.body(),
      nPh,
      nOr,
      beatStep: x.engine_beat_step(h),
    };
  }
}

registerProcessor("chimera-game", GameProcessor);
