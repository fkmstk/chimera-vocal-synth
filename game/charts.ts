/** The stages: beats written as the engine's beat text (16 sixteenths a bar), and which drums the player plays. */
import type { BeatRole } from "../src/wasm/types.ts";

export interface Stage {
  name: string;
  /** announcer line (game/gen-phrases.ts) */
  line: string;
  bpm: number;
  swing: number;
  /** the drums the player plays; the mouth plays the rest by itself */
  play: BeatRole[];
  bars: Record<string, string>;
  /** bar names in order */
  seq: string;
}

const COUNT = "t . . . t . . . t . . . t . . .";
const END = "B . . . . . . . . . . . . . . .";

export const STAGES: Stage[] = [
  {
    name: "Boots and cats",
    line: "s1",
    bpm: 92,
    swing: 0,
    play: ["kick", "snare"],
    bars: {
      n: COUNT,
      a: "B . t . Pf . t . B . t . Pf . t .",
      b: "B . t . Pf . t . B B t . Pf . t .",
      c: "B . t B Pf . t . B . t . Pf . t .",
      d: "B . t . Pf . t . B B t . Pf . Pf .",
      e: END,
    },
    seq: "n a a a b a a c b a b c d e",
  },
  {
    name: "Four on the floor",
    line: "s2",
    bpm: 116,
    swing: 0,
    play: ["kick", "hat", "snare"],
    bars: {
      n: COUNT,
      a: "B . t . B . tss . B . t . B . tss .",
      b: "B . t . B . tss . B . t . Pf . tss .",
      c: "B . t t B . tss . B . t t Pf . kch .",
      e: END,
    },
    seq: "n a a b a a b c b a c b c e",
  },
  {
    name: "Hum bass",
    line: "s3",
    bpm: 96,
    swing: 0.1,
    play: ["kick", "snare", "bass"],
    bars: {
      n: COUNT,
      a: "B . m . Pf . m:43 . B . m:45 . Pf . m:43 .",
      b: "B m . m:43 Pf . m:45 . B m:40 . m Pf . t .",
      c: "B . m:40 . Pf . m:40 m:43 B . m:45 . Pf . m:47 .",
      e: END,
    },
    seq: "n a a b a c b a c b b c b e",
  },
  {
    name: "Breakbeat",
    line: "s4",
    bpm: 98,
    swing: 0.15,
    play: ["kick", "hat", "snare"],
    bars: {
      n: COUNT,
      a: "B . t . Pf . t B . B t . Pf . t .",
      b: "B . t . Pf . t B . B t . Pf . t t",
      c: "B . t K . t B . t . K t . B Pf .",
      d: "B B t . Pf . t . B . t B Pf . K .",
      e: END,
    },
    seq: "n a a b a c b d a c b d d e",
  },
  {
    name: "Chimera",
    line: "s5",
    bpm: 108,
    swing: 0.1,
    play: ["kick", "hat", "snare", "perc", "bass"],
    bars: {
      n: COUNT,
      a: "B . ! . Pf . ! . B B ! . Pf . t .",
      b: "B . t . ^K . t . B B t . ^K . t .",
      c: "B . ! . P! . ! . B . ! . Pf . ! .",
      d: "B m . m:43 Pf . m:45 . B m:40 . m Pf . t kch",
      f: "B . t K . t B . t . K t . B Pf .",
      e: END,
    },
    seq: "n a a b b c c d d a f c d b f d e",
  },
];

/** lane of each drum, left to right */
export const LANE_OF: Record<BeatRole, number> = { kick: 0, hat: 1, snare: 2, perc: 3, bass: 3 };
export const LANES = [
  { name: "KICK", key: "D", free: "B" },
  { name: "HAT", key: "F", free: "t" },
  { name: "SNARE", key: "J", free: "Pf" },
  { name: "BASS", key: "K", free: "m" },
] as const;
