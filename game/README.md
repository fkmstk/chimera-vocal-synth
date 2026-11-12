# CHIMERA: KEEP IT HUMAN

A rhythm game on the CHIMERA engine (`game.html`). One simulated mouth beatboxes each stage on the
engine's sequencer; the player hits the drums marked as theirs (D F J K, or tap the lanes) as they
cross the line. Misses feed the beast: a second engine running a creature barks through, and a full
meter loses the stage. Every sound is the airway model.

```sh
bun run wasm                                  # the engine, as for the app
bun game/gen-phrases.ts                       # announcer lines → phonemes (only after editing them)
bunx vite -c vite.game.config.ts              # dev: http://127.0.0.1:5327/game.html
bunx vite build -c vite.game.config.ts        # static build in dist-game/ (relative URLs)
bunx vite preview -c vite.game.config.ts & bun game/e2e.ts   # headless smoke test
```

- `charts.ts`: the stages, as the engine's beat text.
- `processor.ts`: the worklet. It applies messages at the top of a render quantum, so it can report
  the context time of the sequencer's first hit; key presses are judged against that grid.
- `game.ts`: flow, judging and drawing (the head is the app's `AnatomyRenderer`).
- `audio.ts`: the two engine nodes and the mapping from event time to the sound being heard.
