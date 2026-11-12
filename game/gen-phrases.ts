/** Build-time: the game's announcer lines → phonemes, through the full CMU dictionary. `bun game/gen-phrases.ts` */
import { gunzipSync } from "node:zlib";
import { initChimera, call } from "../src/wasm/chimera.ts";

const LINES: Record<string, string> = {
  s1: "stage one. boots and cats.",
  s2: "stage two. four on the floor.",
  s3: "stage three. hum bass.",
  s4: "stage four. break beat.",
  s5: "final stage. chimera.",
  perfect: "perfect.",
  nice: "nice.",
  close: "that was close.",
  over: "game over.",
  win: "you stayed human.",
  hello: "keep it human.",
};
const root = new URL("..", import.meta.url).pathname;
await initChimera(await Bun.file(root + "src/wasm/chimera.wasm").arrayBuffer());
call("g2pLoad", { text: gunzipSync(await Bun.file(root + "public/data/cmudict.txt.gz").bytes()).toString("utf8") });
const out: Record<string, unknown> = {};
for (const [k, text] of Object.entries(LINES)) {
  const phrases = call<{ segments: unknown[]; intonation: string; pause: number }[]>("g2pPhrases", { text });
  out[k] = phrases.map((p) => ({ segments: p.segments, intonation: p.intonation, pause: Math.min(p.pause, 0.22) }));
}
await Bun.write(root + "game/phrases.generated.json", JSON.stringify(out));
console.log(Object.keys(out).length, "lines");
