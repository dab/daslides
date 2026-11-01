import { Engine } from './engine.ts';
import { UI, WEBGL2_MESSAGE } from './ui.ts';
import { entriesFromFileList, type ImageEntry } from './folder.ts';
import type { TransitionId } from './transitions/index.ts';

const stage = document.getElementById('stage') as HTMLDivElement;
const engine = new Engine();
let items: ImageEntry[] = [];
let initFailed = false;

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
engine.onAllFailed = () =>
  ui.toast('None of those files could be opened. Try a folder of JPEGs.');

// Initialize the renderer in the background. `loadFiles` awaits this before
// driving the engine, so picking still works even if init is slow.
const ready = (async () => {
  // Probe before handing Pixi the canvas. Pixi can resolve init on a WebGL1-only
  // device and then fail to compile every `#version 300 es` shader, which shows
  // up as black slides with no error anywhere.
  if (!document.createElement('canvas').getContext('webgl2')) {
    throw new Error('no-webgl2');
  }
  try {
    await engine.init(stage);
  } catch (err) {
    throw new Error('init-failed', { cause: err });
  }
  // Browsers persist <select>/<input> values across reloads — sync the engine
  // to what the user actually sees before any folder loads.
  const trSel    = document.getElementById('transition') as HTMLSelectElement;
  const dwellInp = document.getElementById('dwell') as HTMLInputElement;
  const tdurInp  = document.getElementById('tdur')  as HTMLInputElement;
  engine.setTransition(trSel.value as TransitionId);
  if (+dwellInp.value > 0) engine.setDwell(+dwellInp.value);
  if (+tdurInp.value  > 0) engine.setTDur(+tdurInp.value);
})().catch((err) => {
  initFailed = true;
  console.error('[slideshow] engine init failed:', err);
  // Only blame WebGL2 when that is actually the problem — this used to report
  // any startup error, including our own bugs, as an unsupported browser.
  ui.showFatal(
    err?.message === 'no-webgl2'
      ? WEBGL2_MESSAGE
      : 'daslides could not start the renderer on this device.',
  );
});

async function loadFiles(name: string, files: ImageEntry[]) {
  if (files.length === 0) {
    ui.toast('No images found in that selection.');
    return;
  }
  // Wait for the renderer BEFORE touching the UI. setFolderName fades out the
  // welcome card, which is where the startup error message lives — so doing
  // this the other way round hid the explanation and left a black screen.
  await ready;
  if (initFailed) return;
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
  engine.setItems(files);
  ui.setActive(0);
  engine.setPlaying(true);
}
