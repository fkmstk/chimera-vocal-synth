/**
 * CHIMERA: KEEP IT HUMAN. A rhythm game on the CHIMERA voice engine.
 *
 * One simulated mouth beatboxes each stage on the engine's own sequencer (sample-accurate); the
 * player hits the drums marked as theirs as they cross the line. Misses feed the beast: a second
 * engine running a creature barks through, the head's lines turn red, and at a full meter the
 * stage is lost. Every sound is the airway model; there are no samples.
 */
import { BEAT_SOUNDS, NEUTRAL, beatReady, creatureById, parseBeat, planPhrases, type BeatRole, type BeatStep, type Segment } from "../src/wasm/engine.ts";
import { VoiceModel } from "../src/ui/analysis.ts";
import { AnatomyRenderer } from "../src/ui/render/anatomy.ts";
import { Glow, beam, beamPts, dot, label, ring, seg, type Pt } from "../src/ui/render/vector.ts";
import { V, mix } from "../src/ui/colors.ts";
import { GameAudio, workletUrl } from "./audio.ts";
import { chimeraModule } from "../src/wasm/chimera.ts";
import { LANES, LANE_OF, STAGES, type Stage } from "./charts.ts";
import PHRASES from "./phrases.generated.json";

type Mode = "title" | "intro" | "play" | "clear" | "over" | "win" | "paused";
type Judge = "perfect" | "great" | "good" | "miss";

interface Note {
  step: number;
  /** seconds after step 0 */
  time: number;
  id: string;
  lane: number;
  /** the player's to hit (the mouth plays the others by itself) */
  mine: boolean;
  judged: Judge | null;
}

const BODY = { female: 0, child: 0 };
const WINDOW: Record<Exclude<Judge, "miss">, number> = { perfect: 0.05, great: 0.095, good: 0.135 };
const POINTS: Record<Judge, number> = { perfect: 300, great: 200, good: 100, miss: 0 };
/** what each judgement does to the beast meter (0..1) */
const BEAST: Record<Judge, number> = { perfect: -0.035, great: -0.018, good: 0, miss: 0.09 };
const JUDGE_COLOR: Record<Judge, string> = { perfect: "#ffe39a", great: "#5be381", good: "#4fb6f2", miss: "#ff5d40" };
const LANE_COLOR = ["#5be381", "#eef6f8", "#ffb340", "#ff73cf"];
const RED = "#ff5d40";
const ROLE = new Map<string, BeatRole>(BEAT_SOUNDS.map((s) => [s.id, s.role]));
const V0 = { ...V };
const VIEW = { pressure: true, particles: true, grid: false, calipers: false };
/** the stacked layout (game.css): the head above the lanes */
const PORTRAIT = window.matchMedia("(max-aspect-ratio: 1/1)");
/** a touch screen: the lanes are tapped, so the key letters are not shown */
const TOUCH = window.matchMedia("(pointer: coarse)");

/** a canvas in CSS pixels with the vector display's glow */
class Surface {
  readonly ctx: CanvasRenderingContext2D;
  private readonly glow = new Glow();
  w = 0;
  h = 0;
  dpr = 1;
  constructor(readonly canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext("2d")!;
  }
  /** true when the size changed */
  fit(): boolean {
    const r = this.canvas.getBoundingClientRect();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (r.width === this.w && r.height === this.h && dpr === this.dpr) return false;
    this.w = r.width;
    this.h = r.height;
    this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(this.w * dpr));
    this.canvas.height = Math.max(1, Math.round(this.h * dpr));
    return true;
  }
  begin(): void {
    const c = this.ctx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalCompositeOperation = "source-over";
    c.globalAlpha = 1;
    c.fillStyle = "#000";
    c.fillRect(0, 0, this.canvas.width, this.canvas.height);
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }
  end(): void {
    this.glow.apply(this.canvas, this.ctx, this.dpr);
  }
}

const store = {
  get(k: string): number | null {
    try {
      const v = localStorage.getItem(k);
      return v === null ? null : Number(v);
    } catch {
      return null;
    }
  },
  set(k: string, v: number): void {
    try {
      localStorage.setItem(k, String(v));
    } catch {
      // private mode: the game works without it
    }
  },
};

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

export class Game {
  private readonly audio = new GameAudio();
  private readonly head: Surface;
  private readonly hw: Surface;
  private readonly card: HTMLElement;
  private readonly renderer = new AnatomyRenderer();
  private readonly model = new VoiceModel(BODY, 48000);
  private readonly scopeBuf = new Float32Array(2048);

  private mode: Mode = "title";
  /** bumped on every mode change: a timer from an earlier mode does nothing */
  private epoch = 0;
  private stageIdx = 0;
  private notes: Note[] = [];
  private steps: (BeatStep | null)[] = [];
  private stepDur = 0.15;
  private swing = 0;
  /** context time of step 0 (null until the sequencer reports it) */
  private t0: number | null = null;
  /** ring halves already written into the sequencer's pattern */
  private fed = 0;
  private missFrom = 0;
  private score = 0;
  private scoreAtStage = 0;
  private combo = 0;
  private maxCombo = 0;
  private counts: Record<Judge, number> = { perfect: 0, great: 0, good: 0, miss: 0 };
  private beast = 0;
  private beastShown = 0;
  private shake = 0;
  private lastBark = 0;
  private best = store.get("chimera-game-best") ?? 0;
  private laneFlash = [0, 0, 0, 0];
  private pops: { text: string; color: string; at: number; lane: number }[] = [];
  private rings: { lane: number; at: number; color: string }[] = [];
  private last = performance.now();
  private busy = false;
  private beastIs = "";

  constructor(root: HTMLElement) {
    this.head = new Surface(root.querySelector<HTMLCanvasElement>("#head")!);
    this.hw = new Surface(root.querySelector<HTMLCanvasElement>("#hw")!);
    this.card = root.querySelector<HTMLElement>("#card")!;
    this.audio.offsetMs = store.get("chimera-game-offset") ?? 0;
    this.audio.onBeatStart = (t) => {
      if (this.mode === "intro" || this.mode === "play") {
        this.t0 = t;
        this.setMode("play");
        this.showBanner();
      }
    };
    window.addEventListener("keydown", (e) => this.onKey(e));
    this.hw.canvas.addEventListener("pointerdown", (e) => this.onPointer(e));
    this.card.addEventListener("click", (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")?.dataset.act;
      if (act) this.act(act);
    });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden && (this.mode === "play" || this.mode === "intro")) this.pause();
    });
    this.showTitle();
    requestAnimationFrame((t) => this.frame(t));
    // a handle for the smoke test (game/e2e.ts)
    (globalThis as { __chimeraGame?: unknown }).__chimeraGame = { game: this, workletUrl, module: chimeraModule() };
  }

  // ------------------------------------------------------------------ flow

  private setMode(m: Mode): void {
    this.mode = m;
    this.epoch++;
  }

  /** run `fn` after `s` seconds unless the mode changed meanwhile */
  private later(s: number, fn: () => void): void {
    const e = this.epoch;
    setTimeout(() => {
      if (e === this.epoch) fn();
    }, s * 1000);
  }

  private act(a: string): void {
    if (a === "start") void this.begin(0, true);
    else if (a === "next") void this.begin(this.stageIdx + 1, false);
    else if (a === "retry") void this.begin(this.stageIdx, false);
    else if (a === "title") this.toTitle();
    else if (a === "late" || a === "early") this.nudge(a === "late" ? 10 : -10);
  }

  private nudge(ms: number): void {
    this.audio.offsetMs = Math.max(-300, Math.min(300, this.audio.offsetMs + ms));
    store.set("chimera-game-offset", this.audio.offsetMs);
    const el = this.card.querySelector(".offset");
    if (el) el.textContent = `${this.audio.offsetMs > 0 ? "+" : ""}${this.audio.offsetMs} ms`;
  }

  private async ensureAudio(): Promise<boolean> {
    try {
      await this.audio.start();
      return true;
    } catch (e) {
      this.card.className = "card";
      this.card.innerHTML = `<h2>AUDIO FAILED</h2><p class="jp">音声エンジンを起動できませんでした: ${esc(e instanceof Error ? e.message : String(e))}</p><button data-act="title">BACK</button>`;
      return false;
    }
  }

  private speak(key: keyof typeof PHRASES): number {
    const phrases = PHRASES[key] as { segments: Segment[]; intonation: "statement" | "question"; pause: number }[];
    const plan = planPhrases(phrases, { body: BODY, t0: 0, rate: 1.05, f0: 104 });
    this.audio.setMic(false);
    this.audio.voice({ type: "schedule", gestures: plan.gestures, replace: true, lead: 0.05 });
    return plan.end;
  }

  private async begin(idx: number, fresh: boolean): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    const ok = await this.ensureAudio();
    this.busy = false;
    if (!ok) return;
    if (fresh) this.score = 0;
    if (idx !== this.stageIdx || fresh) this.scoreAtStage = this.score;
    else this.score = this.scoreAtStage;
    this.stageIdx = idx;
    const st = STAGES[idx];
    this.build(st);
    this.combo = 0;
    this.maxCombo = 0;
    this.counts = { perfect: 0, great: 0, good: 0, miss: 0 };
    this.beast = 0;
    this.t0 = null;
    this.fed = 2;
    this.missFrom = 0;
    this.pops = [];
    this.rings = [];
    this.setMode("intro");
    this.showBanner();
    this.audio.voice({ type: "beat", playing: false });
    this.audio.beast({ type: "stopCall" });
    // the seal is loaded now, in the quiet before the beat, so a miss only has to call it
    this.beastIs = "seal";
    this.audio.beast({ type: "creature", id: "seal" });
    const dur = this.speak(st.line as keyof typeof PHRASES);
    this.later(dur + 0.45, () => {
      this.audio.setMic(true);
      this.audio.voice({ type: "artic", values: beatReady(BODY) });
      this.audio.voice({ type: "beat", steps: this.ring(), bpm: st.bpm, swing: st.swing, playing: true });
    });
  }

  /** Wake the beast's engine as this creature and play one of its calls. */
  private bark(creature: string, id: string): void {
    const dur = creatureById(creature)?.calls.find((c) => c.id === id)?.keys.at(-1)?.t ?? 2;
    if (creature !== this.beastIs) {
      this.beastIs = creature;
      this.audio.beast({ type: "creature", id: creature });
    }
    this.audio.beast({ type: "call", id, hold: dur + 0.7 });
  }

  private build(st: Stage): void {
    this.steps = [];
    for (const name of st.seq.split(" ")) {
      const bar = parseBeat(st.bars[name]);
      if (bar.length !== 16) throw new Error(`stage ${st.name}, bar ${name}: ${bar.length} steps`);
      this.steps.push(...bar);
    }
    this.stepDur = 60 / st.bpm / 4;
    this.swing = st.swing;
    this.notes = [];
    this.steps.forEach((s, i) => {
      if (!s) return;
      const role = ROLE.get(s.id) ?? "perc";
      // the count-in bar is the mouth's alone
      this.notes.push({ step: i, time: this.stepTime(i), id: s.id, lane: LANE_OF[role], mine: i >= 16 && st.play.includes(role), judged: null });
    });
  }

  private stepTime(n: number): number {
    return n * this.stepDur + (n % 2 === 1 ? this.swing * 0.5 * this.stepDur : 0);
  }

  /**
   * The sequencer loops a pattern of at most 128 steps, so a longer stage is fed through it as a
   * ring of two 64-step halves: slot p holds the stage's latest step n with n % 128 === p that has
   * been fed, and each half is rewritten once the playhead is well inside the other.
   */
  private ring(): (BeatStep | null)[] {
    const out: (BeatStep | null)[] = new Array(128).fill(null);
    for (let half = Math.max(0, this.fed - 2); half < this.fed; half++) {
      for (let i = 0; i < 64; i++) out[(half % 2) * 64 + i] = this.steps[half * 64 + i] ?? null;
    }
    return out;
  }

  private finish(): void {
    const st = STAGES[this.stageIdx];
    this.audio.voice({ type: "beat", playing: false });
    const mine = this.notes.filter((n) => n.mine).length;
    const acc = mine ? (this.counts.perfect + 0.7 * this.counts.great + 0.4 * this.counts.good) / mine : 1;
    const rank = acc >= 0.95 ? "S" : acc >= 0.85 ? "A" : acc >= 0.7 ? "B" : "C";
    const last = this.stageIdx === STAGES.length - 1;
    this.setMode(last ? "win" : "clear");
    this.saveBest();
    this.bark("songbird", last ? "flute" : "trill");
    this.later(1.5, () => void this.speak(last ? "win" : rank === "S" ? "perfect" : rank === "C" ? "close" : "nice"));
    const c = this.counts;
    this.card.className = "card";
    this.card.innerHTML = `
      <p class="kicker">${last ? "ALL STAGES CLEAR" : `STAGE ${this.stageIdx + 1} CLEAR`}</p>
      <h2>${last ? "YOU STAYED HUMAN" : esc(st.name.toUpperCase())}</h2>
      <div class="rank rank-${rank}">${rank}</div>
      <table><tr><td>PERFECT</td><td>${c.perfect}</td></tr><tr><td>GREAT</td><td>${c.great}</td></tr><tr><td>GOOD</td><td>${c.good}</td></tr><tr><td>MISS</td><td>${c.miss}</td></tr><tr><td>MAX COMBO</td><td>${this.maxCombo}</td></tr></table>
      <p class="score">${this.score.toLocaleString("en-US")}</p>
      <p class="jp">${last ? `最後まで人間のまま歌いきった。ベスト ${this.best.toLocaleString("en-US")}` : "鳥が鳴いたらクリアの合図。次のビートへ。"}</p>
      <div class="row">${last ? `<button data-act="start">PLAY AGAIN</button>` : `<button data-act="next">NEXT STAGE</button>`}<button class="ghost" data-act="title">TITLE</button></div>
      <p class="hint">SPACE / ENTER</p>`;
  }

  private lose(): void {
    this.setMode("over");
    this.saveBest();
    this.audio.voice({ type: "beat", playing: false });
    this.bark("elephant", "trumpet");
    this.shake = 1;
    this.later(1.7, () => void this.speak("over"));
    this.card.className = "card over";
    this.card.innerHTML = `
      <p class="kicker">STAGE ${this.stageIdx + 1} · ${esc(STAGES[this.stageIdx].name.toUpperCase())}</p>
      <h2>THE BEAST IS OUT</h2>
      <p class="score">${this.score.toLocaleString("en-US")}</p>
      <p class="jp">ミスが重なって獣が出てきてしまった。もう一度このステージから。</p>
      <div class="row"><button data-act="retry">RETRY</button><button class="ghost" data-act="title">TITLE</button></div>
      <p class="hint">SPACE / ENTER</p>`;
  }

  private pause(): void {
    this.setMode("paused");
    this.audio.voice({ type: "beat", playing: false });
    this.audio.voice({ type: "stopSpeech" });
    this.card.className = "card";
    this.card.innerHTML = `<h2>PAUSED</h2><p class="jp">画面を離れたのでビートを止めました。このステージの頭からやり直します。</p><div class="row"><button data-act="retry">RESTART STAGE</button><button class="ghost" data-act="title">TITLE</button></div>`;
  }

  private toTitle(): void {
    this.audio.voice({ type: "beat", playing: false });
    this.audio.voice({ type: "stopSpeech" });
    this.audio.beast({ type: "stopCall" });
    this.beast = 0;
    this.t0 = null;
    this.notes = [];
    this.showTitle();
  }

  private saveBest(): void {
    if (this.score > this.best) {
      this.best = this.score;
      store.set("chimera-game-best", this.best);
    }
  }

  private showTitle(): void {
    this.setMode("title");
    const o = this.audio.offsetMs;
    this.card.className = "card title";
    this.card.innerHTML = `
      <p class="kicker">A BEATBOX RHYTHM GAME ON A SIMULATED MOUTH</p>
      <h1>CHIMERA</h1>
      <p class="sub">KEEP IT HUMAN</p>
      <p class="jp">声帯・舌・唇を物理シミュレーションした「口」がビートボックスを刻む。光るノーツがラインに重なった瞬間に叩け。外すたびに獣が漏れ出し、ゲージが満ちると乗っ取られる。</p>
      <div class="keys">${LANES.map((l, i) => `<span style="--c:${LANE_COLOR[i]}"><b>${l.key}</b>${l.name}</span>`).join("")}</div>
      <div class="row"><button data-act="start">START</button></div>
      <p class="hint">SPACE / ENTER</p>
      <p class="jp note">スマホはレーンをタップ。タイトル画面では下のパッドで試し打ちできる。</p>
      <div class="timing"><span class="jp">音がズレて聞こえるとき（Bluetoothなど）</span><button class="ghost small" data-act="early">−</button><span class="offset">${o > 0 ? "+" : ""}${o} ms</span><button class="ghost small" data-act="late">+</button></div>
      ${this.best ? `<p class="best">BEST ${this.best.toLocaleString("en-US")}</p>` : ""}`;
  }

  private showBanner(): void {
    const st = STAGES[this.stageIdx];
    const mine = [...new Set(st.play.map((r) => LANES[LANE_OF[r]].name))].join(" · ");
    this.card.className = "card banner";
    this.card.innerHTML = `<p class="kicker">STAGE ${this.stageIdx + 1} / ${STAGES.length} · ${st.bpm} BPM</p><h2>${esc(st.name.toUpperCase())}</h2><p class="kicker">YOU PLAY: ${mine}</p>`;
  }

  // ------------------------------------------------------------------ input

  private onKey(e: KeyboardEvent): void {
    if (e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    const lane = LANES.findIndex((l) => l.key.toLowerCase() === k);
    if (lane >= 0) {
      e.preventDefault();
      this.hit(lane, e.timeStamp);
    } else if (k === " " || k === "enter") {
      e.preventDefault();
      // a focused button takes Enter and Space itself
      if (document.activeElement instanceof HTMLButtonElement) return;
      if (this.mode === "title") this.act("start");
      else if (this.mode === "clear") this.act("next");
      else if (this.mode === "win") this.act("start");
      else if (this.mode === "over" || this.mode === "paused") this.act("retry");
    } else if (k === "escape") {
      if (this.mode !== "title") this.toTitle();
    } else if (k === "[" || k === "]") this.nudge(k === "]" ? 10 : -10);
  }

  private onPointer(e: PointerEvent): void {
    const r = this.hw.canvas.getBoundingClientRect();
    const g = this.geom();
    const lane = Math.floor((e.clientX - r.left - g.x0) / g.laneW);
    if (lane < 0 || lane > 3) return;
    e.preventDefault();
    this.hit(lane, e.timeStamp);
  }

  private hit(lane: number, stamp: number): void {
    this.laneFlash[lane] = 1;
    if (this.mode === "title") {
      // warm-up: the pads play the mouth directly
      void this.audio.start().then(() => {
        this.audio.setMic(true);
        this.audio.voice({ type: "beatHit", id: LANES[lane].free });
      }, () => {});
      return;
    }
    if (this.mode !== "play" || this.t0 === null) return;
    const t = this.audio.heard(stamp) - this.t0;
    let best: Note | null = null;
    for (let i = this.missFrom; i < this.notes.length; i++) {
      const n = this.notes[i];
      if (n.time - t > WINDOW.good) break;
      if (!n.mine || n.judged || n.lane !== lane) continue;
      if (!best || Math.abs(n.time - t) < Math.abs(best.time - t)) best = n;
    }
    if (!best) return;
    const d = Math.abs(best.time - t);
    this.judge(best, d <= WINDOW.perfect ? "perfect" : d <= WINDOW.great ? "great" : "good");
  }

  private judge(n: Note, j: Judge): void {
    n.judged = j;
    this.counts[j]++;
    const now = performance.now();
    if (j === "miss") {
      this.combo = 0;
      this.shake = Math.max(this.shake, 0.6);
      if (now - this.lastBark > 240) {
        this.lastBark = now;
        // the seal's laser chirp, higher as the beast closes in
        this.bark("seal", this.beast > 0.6 ? "chug" : "zap");
      }
    } else {
      this.combo++;
      this.maxCombo = Math.max(this.maxCombo, this.combo);
      this.score += Math.round(POINTS[j] * (1 + Math.min(this.combo, 50) / 50));
      this.rings.push({ lane: n.lane, at: now, color: JUDGE_COLOR[j] });
    }
    this.beast = Math.max(0, Math.min(1, this.beast + BEAST[j]));
    this.pops.push({ text: j.toUpperCase(), color: JUDGE_COLOR[j], at: now, lane: n.lane });
    if (this.pops.length > 6) this.pops.shift();
    if (this.beast >= 1 && this.mode === "play") this.lose();
  }

  // ------------------------------------------------------------------ frame

  private frame(now: number): void {
    const dt = Math.min(0.05, (now - this.last) / 1000);
    const elapsed = Math.min(0.5, (now - this.last) / 1000);
    this.last = now;
    if (this.mode === "play" && this.t0 !== null) this.update();
    this.beastShown += (this.beast - this.beastShown) * Math.min(1, dt * 8);
    this.shake = Math.max(0, this.shake - dt * 2.2);
    for (let i = 0; i < 4; i++) this.laneFlash[i] = Math.max(0, this.laneFlash[i] - dt * 6);
    // the display's blue runs to red as the beast takes over
    const m = Math.pow(this.mode === "over" ? 1 : this.beastShown, 1.4) * 0.9;
    V.blue = mix(V0.blue, RED, m);
    V.blueMid = mix(V0.blueMid, "#c43a22", m);
    V.blueDim = mix(V0.blueDim, "#8c2a16", m);
    V.frame = mix(V0.frame, "#541a10", m);
    this.drawHead(dt, elapsed);
    this.drawHighway(now);
    requestAnimationFrame((t) => this.frame(t));
  }

  private update(): void {
    const t = this.audio.heard() - this.t0!;
    // notes gone past the window are misses
    while (this.missFrom < this.notes.length && this.notes[this.missFrom].time < t - WINDOW.good) {
      const n = this.notes[this.missFrom++];
      if (n.mine && !n.judged) this.judge(n, "miss");
      if (this.mode !== "play") return;
    }
    // feed the next half of the stage once the playhead is well into the current one
    const step = t / this.stepDur;
    if (step >= (this.fed - 1) * 64 + 8 && this.fed * 64 < this.steps.length) {
      this.fed++;
      this.audio.voice({ type: "beat", steps: this.ring() });
    }
    if (t > this.steps.length * this.stepDur + 0.2) this.finish();
    else if (t > 16 * this.stepDur && this.card.classList.contains("banner")) this.card.className = "card hidden";
  }

  private shakeOffset(): [number, number] {
    const s = this.shake * this.shake * 9;
    return s > 0.05 ? [(Math.random() - 0.5) * s, (Math.random() - 0.5) * s] : [0, 0];
  }

  private drawHead(dt: number, elapsed: number): void {
    const s = this.head;
    // the renderer's narrow layout leaves room for readouts the game does not draw: a small
    // canvas is drawn as a 560 px one, scaled down, so the head fills it
    const k = Math.max(1, 560 / Math.max(1, this.head.canvas.getBoundingClientRect().width));
    if (s.fit()) this.renderer.resize(s.w * k, s.h * k);
    if (s.w < 2 || s.h < 2) return;
    const tele = this.audio.latest;
    const a = tele ? VoiceModel.articFromArray(tele.t.artic) : NEUTRAL;
    this.renderer.face.update(tele, elapsed);
    const f = this.model.frame(a);
    s.begin();
    const c = s.ctx;
    const [sx, sy] = this.shakeOffset();
    c.save();
    c.translate(sx, sy);
    if (PORTRAIT.matches) {
      // a phone held upright: a close-up of the vocal tract (nose to larynx), as large as the
      // canvas allows, because the whole head would leave the moving parts a few millimetres wide
      const r = this.renderer;
      const x0 = r.X({ x: -3.6, y: 0 }), x1 = r.X({ x: 9.6, y: 0 }), y0 = r.Y({ x: 0, y: 13.6 }), y1 = r.Y({ x: 0, y: -1.4 });
      const z = Math.min(s.w / (x1 - x0), s.h / (y1 - y0));
      c.translate(s.w / 2, s.h / 2);
      c.scale(z, z);
      c.translate(-(x0 + x1) / 2, -(y0 + y1) / 2);
    } else c.scale(1 / k, 1 / k);
    this.renderer.draw(c, this.model, f, a, tele, VIEW, { hover: null, drag: null, dt, formants: [], slots: [], info: [] });
    c.restore();
    // the sound itself, under the chin
    const an = this.audio.scope;
    if (an) {
      an.getFloatTimeDomainData(this.scopeBuf);
      const n = 512, y0 = s.h - 26, amp = Math.min(22, s.h * 0.05);
      const pts: Pt[] = [];
      for (let i = 0; i < n; i++) pts.push([12 + ((s.w - 24) * i) / (n - 1), y0 - Math.max(-1, Math.min(1, this.scopeBuf[i] * 2.4)) * amp]);
      beamPts(c, pts, V0.amber, 1.2, { alpha: 0.9 });
    }
    if (this.audio.beastLevel > 0.004 && this.mode !== "clear" && this.mode !== "win") {
      label(c, "BEAST", s.w / 2, 26, { size: 15, color: RED, align: "center", weight: "m", alpha: 0.5 + 0.5 * Math.random() });
    }
    s.end();
  }

  private geom(): { x0: number; laneW: number; top: number; hitY: number } {
    const { w, h } = this.hw;
    const laneW = Math.min(104, (w - 24) / 4);
    return { x0: (w - 4 * laneW) / 2, laneW, top: 74, hitY: h - Math.max(70, Math.min(120, h * 0.16)) };
  }

  private drawHighway(now: number): void {
    const s = this.hw;
    s.fit();
    if (s.w < 2 || s.h < 2) return;
    s.begin();
    const c = s.ctx;
    const { w } = s;
    const g = this.geom();
    const [sx, sy] = this.shakeOffset();
    c.save();
    c.translate(sx, sy);
    const playing = (this.mode === "play" || this.mode === "over") && this.t0 !== null;
    const t = playing && this.mode === "play" ? this.audio.heard() - this.t0! : -1e9;
    const st = STAGES[this.stageIdx];
    const span = (60 / st.bpm) * 4; // a bar on screen
    const pps = (g.hitY - g.top) / span;
    const xl = (lane: number) => g.x0 + (lane + 0.5) * g.laneW;
    const right = g.x0 + 4 * g.laneW;

    // lanes
    for (let i = 0; i <= 4; i++) seg(c, g.x0 + i * g.laneW, g.top, g.x0 + i * g.laneW, s.h - 8, V.frame, 1, { alpha: 0.9 });
    for (let i = 0; i < 4; i++) {
      if (this.laneFlash[i] > 0) {
        c.save();
        c.globalCompositeOperation = "lighter";
        c.globalAlpha = 0.16 * this.laneFlash[i];
        c.fillStyle = LANE_COLOR[i];
        c.fillRect(g.x0 + i * g.laneW + 1, g.top, g.laneW - 2, s.h - 8 - g.top);
        c.restore();
      }
    }

    if (this.mode === "play" && this.t0 !== null) {
      // beat and bar lines
      const beat = 4 * this.stepDur;
      for (let b = Math.max(0, Math.floor(t / beat)); b * beat < t + span; b++) {
        const y = g.hitY - (b * beat - t) * pps;
        if (y < g.top) break;
        seg(c, g.x0, y, right, y, b % 4 === 0 ? V.blueMid : V.blueDim, b % 4 === 0 ? 1.1 : 0.8, { alpha: b % 4 === 0 ? 0.8 : 0.45 });
      }
      // the combo, big and faint behind the notes
      if (this.combo >= 4) {
        label(c, String(this.combo), w / 2, g.top + (g.hitY - g.top) * 0.42, { size: Math.min(120, g.laneW * 1.3), color: V0.amber, align: "center", baseline: "middle", weight: "m", alpha: 0.2, ls: 0.02 });
        label(c, "COMBO", w / 2, g.top + (g.hitY - g.top) * 0.42 + Math.min(120, g.laneW * 1.3) * 0.62, { size: 12, color: V0.amber, align: "center", alpha: 0.35 });
      }
      // notes
      for (const n of this.notes) {
        if (n.time < t - 0.3) continue;
        if (n.time > t + span) break;
        const y = g.hitY - (n.time - t) * pps;
        const x = xl(n.lane);
        if (!n.mine) {
          // the mouth's own notes: small and dim
          if (n.time > t) dot(c, x, y, 2.6, LANE_COLOR[n.lane], 0.38);
          continue;
        }
        if (n.judged && n.judged !== "miss") continue;
        const col = n.judged === "miss" ? RED : LANE_COLOR[n.lane];
        const alpha = n.judged === "miss" ? Math.max(0, 1 - (t - n.time) / 0.3) * 0.7 : 1;
        this.glyph(c, n.lane, x, y, Math.min(17, g.laneW * 0.24), col, alpha);
        label(c, n.id, x, y + 4, { size: 11, color: col, align: "center", alpha: alpha * 0.9, ls: 0 });
      }
    }

    // the hit line and pads
    seg(c, g.x0, g.hitY, right, g.hitY, V.blue, 1.6, { hot: true });
    for (let i = 0; i < 4; i++) {
      const x = xl(i), r = Math.min(24, g.laneW * 0.32);
      ring(c, x, g.hitY, r, LANE_COLOR[i], 1.3, { alpha: 0.55 + 0.45 * this.laneFlash[i], hot: this.laneFlash[i] > 0.5 });
      if (TOUCH.matches) label(c, LANES[i].name, x, g.hitY + r + 20, { size: 11, color: LANE_COLOR[i], align: "center" });
      else {
        label(c, LANES[i].key, x, g.hitY + r + 22, { size: 17, color: LANE_COLOR[i], align: "center", weight: "m" });
        label(c, LANES[i].name, x, g.hitY + r + 38, { size: 9.5, color: LANE_COLOR[i], align: "center", alpha: 0.8 });
      }
    }
    for (const r of this.rings) {
      const u = (now - r.at) / 320;
      if (u < 1) ring(c, xl(r.lane), g.hitY, 20 + u * 34, r.color, 1.6, { alpha: (1 - u) * (1 - u), hot: true });
    }
    this.rings = this.rings.filter((r) => now - r.at < 320);
    for (const p of this.pops) {
      const u = (now - p.at) / 520;
      if (u < 1) label(c, p.text, xl(p.lane), g.hitY - 46 - u * 26, { size: 13, color: p.color, align: "center", weight: "m", alpha: 1 - u * u, moving: true });
    }
    this.pops = this.pops.filter((p) => now - p.at < 520);

    // head-up display
    if (this.mode !== "title") {
      label(c, `STAGE ${this.stageIdx + 1}/${STAGES.length}`, g.x0, 22, { size: 11, color: V.blueMid });
      label(c, st.name.toUpperCase(), g.x0, 42, { size: 15, color: V.blue, weight: "m" });
      label(c, this.score.toLocaleString("en-US"), right, 42, { size: 22, color: V0.amber, align: "right", weight: "m", ls: 0.06 });
      label(c, "SCORE", right, 20, { size: 10, color: V.blueMid, align: "right" });
      // the beast meter
      const bx = g.x0, bw = right - g.x0, by = 58;
      const path = new Path2D();
      path.rect(bx, by, bw, 8);
      beam(c, path, V.blueDim, 1);
      const fill = Math.max(0, Math.min(1, this.beastShown));
      if (fill > 0.004) {
        c.save();
        c.globalCompositeOperation = "lighter";
        c.globalAlpha = fill > 0.7 ? 0.65 + 0.35 * Math.sin(now / 70) : 0.85;
        c.fillStyle = RED;
        c.fillRect(bx + 1.5, by + 1.5, (bw - 3) * fill, 5);
        c.restore();
      }
      label(c, "BEAST", bx + bw / 2, by + 7.5, { size: 9, color: fill > 0.5 ? "#ffffff" : RED, align: "center", alpha: 0.9 });
      // progress through the stage
      if (this.mode === "play" && this.t0 !== null) {
        const u = Math.max(0, Math.min(1, t / (this.steps.length * this.stepDur)));
        seg(c, bx, s.h - 4, bx + bw * u, s.h - 4, V0.amber, 1.4, { alpha: 0.8 });
      }
    }
    c.restore();
    s.end();
  }

  /** a note: each lane has its own shape, so colour is never the only cue */
  private glyph(c: CanvasRenderingContext2D, lane: number, x: number, y: number, r: number, color: string, alpha: number): void {
    const p = new Path2D();
    if (lane === 0) p.arc(x, y, r, 0, Math.PI * 2);
    else if (lane === 1) {
      p.moveTo(x, y - r * 1.15);
      p.lineTo(x + r * 1.15, y);
      p.lineTo(x, y + r * 1.15);
      p.lineTo(x - r * 1.15, y);
      p.closePath();
    } else if (lane === 2) p.rect(x - r, y - r * 0.82, 2 * r, 1.64 * r);
    else {
      for (let i = 0; i < 6; i++) {
        const an = (Math.PI / 3) * i;
        if (i === 0) p.moveTo(x + r * 1.1, y);
        else p.lineTo(x + Math.cos(an) * r * 1.1, y + Math.sin(an) * r * 1.1);
      }
      p.closePath();
    }
    c.save();
    c.globalAlpha = alpha * 0.85;
    c.fillStyle = "#000";
    c.fill(p);
    c.restore();
    beam(c, p, color, 1.8, { alpha, hot: true });
  }
}
