/** Entry: the engine (wasm) loads first, because the modules the game imports call into it as they load. */
import "./game.css";
import { initChimera } from "../src/wasm/chimera.ts";

const root = document.getElementById("app")!;

async function boot(): Promise<void> {
  const card = document.getElementById("card")!;
  try {
    await initChimera();
    await document.fonts.load('300 16px "Hershey"').catch(() => {});
    await document.fonts.load('500 16px "Hershey"').catch(() => {});
    const { Game } = await import("./game.ts");
    new Game(root);
  } catch (err) {
    card.className = "card";
    card.replaceChildren();
    const h = document.createElement("h2");
    h.textContent = "ENGINE FAILED";
    const p = document.createElement("p");
    p.className = "jp";
    p.textContent = `音声エンジンを読み込めませんでした: ${err instanceof Error ? err.message : String(err)}`;
    const b = document.createElement("button");
    b.textContent = "RETRY";
    b.onclick = () => void boot();
    card.append(h, p, b);
  }
}

void boot();
