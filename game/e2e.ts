/**
 * Headless smoke test of the built game: `bunx vite preview -c vite.game.config.ts`, then `bun game/e2e.ts`.
 * 1. offline: the sequencer's hits land where the worklet's beatStart says (onsets against the grid);
 * 2. live: a bot plays stage 1 on the beat (the stage clears without a miss), then a run with no
 *    presses loses it to the beast.
 */
import { chromium } from "playwright-core";
import { mkdirSync } from "node:fs";

const url = process.argv[2] ?? "http://127.0.0.1:5328/game.html";
const out = "out/game-e2e";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME ?? "/usr/bin/google-chrome", args: ["--autoplay-policy=no-user-gesture-required", "--no-sandbox"] });
const errors: string[] = [];
const page = await browser.newPage({ viewport: { width: 1280, height: 760 }, deviceScaleFactor: 1 });
page.on("console", (m) => (m.type() === "error" ? errors.push(m.text()) : console.log("  page:", m.text())));
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
await page.goto(url, { waitUntil: "networkidle" });
await page.waitForFunction(() => !!(globalThis as any).__chimeraGame);
await page.waitForTimeout(500);
await page.screenshot({ path: `${out}/0-title.png` });

// ---- 1. offline: where do the hits land?
const timing = await page.evaluate(async () => {
  const { workletUrl, module } = (globalThis as any).__chimeraGame;
  const sr = 48000, bpm = 120;
  const ctx = new OfflineAudioContext(1, sr * 3, sr);
  await ctx.audioWorklet.addModule(workletUrl);
  const node = new AudioWorkletNode(ctx, "chimera-game", { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: { module, telemetry: false } });
  node.connect(ctx.destination);
  let start = -1;
  node.port.onmessage = (e) => {
    if (e.data.type === "beatStart") start = e.data.time;
  };
  const kick = { id: "B" };
  const steps = Array.from({ length: 16 }, (_, i) => (i % 4 === 0 ? kick : null));
  // messages reach the worklet only while rendering is paused: an offline context does not wait for them
  void ctx.suspend(0.1).then(async () => {
    node.port.postMessage({ type: "beat", steps, bpm, swing: 0, playing: true });
    await new Promise((r) => setTimeout(r, 100));
    void ctx.resume();
  });
  const buf = (await ctx.startRendering()).getChannelData(0);
  // onset: first sample of each burst over a fraction of the peak
  let peak = 0;
  for (const v of buf) peak = Math.max(peak, Math.abs(v));
  const onsets: number[] = [];
  let quietUntil = 0;
  for (let i = 0; i < buf.length; i++) {
    if (i >= quietUntil && Math.abs(buf[i]) > peak * 0.25) {
      onsets.push(i / sr);
      quietUntil = i + sr * 0.3;
    }
  }
  return { start, peak, onsets, expected: onsets.map((_, k) => start + k * (60 / bpm)) };
});
console.log("offline timing", JSON.stringify(timing));
const worst = Math.max(...timing.onsets.map((t: number, i: number) => Math.abs(t - timing.expected[i])));
console.log(`  worst onset error ${(worst * 1000).toFixed(1)} ms over ${timing.onsets.length} kicks`);

// ---- 2. live: a bot on the beat
async function run(bot: boolean, tag: string): Promise<any> {
  await page.evaluate(() => (globalThis as any).__chimeraGame.game.toTitle());
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => (globalThis as any).__chimeraGame.game.mode === "play", null, { timeout: 40000 });
  if (bot) {
    await page.evaluate(() => {
      const g = (globalThis as any).__chimeraGame.game;
      const keys = ["d", "f", "j", "k"];
      const id = setInterval(() => {
        if (g.mode !== "play") return clearInterval(id);
        const t = g.audio.heard() - g.t0;
        for (const n of g.notes) {
          if (n.mine && !n.judged && !n.sent && n.time <= t) {
            n.sent = true;
            window.dispatchEvent(new KeyboardEvent("keydown", { key: keys[n.lane] }));
          }
        }
      }, 4);
    });
  }
  await page.waitForTimeout(7000);
  await page.screenshot({ path: `${out}/${tag}-play.png` });
  await page.waitForFunction(() => (globalThis as any).__chimeraGame.game.mode !== "play", null, { timeout: 150000 });
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${out}/${tag}-end.png` });
  return page.evaluate(() => {
    const g = (globalThis as any).__chimeraGame.game;
    return { mode: g.mode, score: g.score, counts: g.counts, maxCombo: g.maxCombo, load: g.audio.load, beastLoad: g.audio.beastLoad, error: g.audio.error, sr: g.audio.ctx.sampleRate };
  });
}
const a = await run(true, "1-bot");
console.log("bot run", JSON.stringify(a));
const b = await run(false, "2-idle");
console.log("idle run", JSON.stringify(b));

// phone, portrait
const phone = await browser.newPage({ viewport: { width: 390, height: 780 }, deviceScaleFactor: 2, hasTouch: true });
await phone.goto(url, { waitUntil: "networkidle" });
await phone.waitForFunction(() => !!(globalThis as any).__chimeraGame);
await phone.waitForTimeout(400);
await phone.screenshot({ path: `${out}/3-phone-title.png` });
await phone.getByRole("button", { name: "START" }).click();
await phone.waitForFunction(() => (globalThis as any).__chimeraGame.game.mode === "play", null, { timeout: 40000 });
await phone.waitForTimeout(6000);
await phone.screenshot({ path: `${out}/3-phone-play.png` });

await browser.close();
console.log(errors.length ? "ERRORS:\n" + errors.join("\n") : "no console errors");
const ok = !errors.length && worst < 0.012 && a.mode === "clear" && a.counts.miss === 0 && b.mode === "over";
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
