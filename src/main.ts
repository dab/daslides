import { Engine } from './engine.ts';
import { UI } from './ui.ts';
import { entriesFromFileList, type ImageEntry } from './folder.ts';
import type { TransitionId } from './transitions/index.ts';

const stage = document.getElementById('stage') as HTMLDivElement;
const engine = new Engine();
let items: ImageEntry[] = [];

// Build the UI and wire every handler FIRST — independent of the renderer. If
// engine.init() were awaited up front and ever stalled/failed, `new UI()` would
// never run and the controls/pickers would be dead. Decoupling guarantees the
// UI always works.
const ui = new UI({
  // Pickers are native <label for> elements that open the hidden file inputs —
  // no JS gesture handling needed (reliable in every browser incl. Brave/mobile).
  onFilesPicked: (list) => {
    const { name, files } = entriesFromFileList(list, 'Selected photos');
    loadFiles(name, files);
  },
  onPlayToggle: () => engine.togglePlay(),
  onPrev: () => engine.prev(),
  onNext: () => engine.next(),
  onShuffle: () => {
    const shuffled = engine.shuffle();
    if (shuffled) {
      items = shuffled;
      ui.renderList(items);
      ui.setActive(engine.getCursor());
    }
  },
  onFullscreen: () => {
    const el = document.documentElement as any;
    const doc = document as any;
    const req = el.requestFullscreen || el.webkitRequestFullscreen;
    const exit = doc.exitFullscreen || doc.webkitExitFullscreen;
    const active = document.fullscreenElement || doc.webkitFullscreenElement;
    if (!req) { ui.showInstallHint(); return; } // iPhone: no element Fullscreen API
    if (!active) req.call(el); else exit?.call(doc);
  },
  onTransition: (id) => engine.setTransition(id as TransitionId),
  onDwell: (s) => engine.setDwell(s),
  onTDur: (s) => engine.setTDur(s),
  onJump: (i) => engine.jump(i),
});

engine.onSlideChange = (i) => ui.setActive(i);
engine.onPlayingChange = (p) => ui.setPlaying(p);

// Initialize the renderer in the background. `loadFiles` awaits this before
// driving the engine, so picking still works even if init is slow.
const ready = (async () => {
  console.info('[slideshow] engine init…');
  await engine.init(stage);
  // Browsers persist <select>/<input> values across reloads — sync the engine
  // to what the user actually sees before any folder loads.
  const trSel    = document.getElementById('transition') as HTMLSelectElement;
  const dwellInp = document.getElementById('dwell') as HTMLInputElement;
  const tdurInp  = document.getElementById('tdur')  as HTMLInputElement;
  engine.setTransition(trSel.value as TransitionId);
  if (+dwellInp.value > 0) engine.setDwell(+dwellInp.value);
  if (+tdurInp.value  > 0) engine.setTDur(+tdurInp.value);
  console.info('[slideshow] engine ready');
})().catch((err) => console.error('[slideshow] engine init failed:', err));

async function loadFiles(name: string, files: ImageEntry[]) {
  console.info('[slideshow] files picked:', files.length, '→', name);
  if (files.length === 0) {
    alert('No images found in the selection.');
    return;
  }
  // "Shuffle on load" — Fisher–Yates the items so playback doesn't always start
  // at file #1. Browsers persist the checkbox state across reloads.
  const shuffleOnLoad = (document.getElementById('shuffle-on-load') as HTMLInputElement)?.checked;
  if (shuffleOnLoad && files.length > 1) {
    for (let i = files.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [files[i], files[j]] = [files[j], files[i]];
    }
  }
  items = files;
  ui.setFolderName(name);
  ui.renderList(files);
  await ready;              // ensure the renderer is initialized before driving it
  engine.setItems(files);
  ui.setActive(0);
  engine.setPlaying(true);
}
