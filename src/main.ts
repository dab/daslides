import { Engine } from './engine.ts';
import { UI } from './ui.ts';
import { entriesFromFileList, type ImageEntry } from './folder.ts';
import type { TransitionId } from './transitions/index.ts';

const stage = document.getElementById('stage') as HTMLDivElement;
const engine = new Engine();
let items: ImageEntry[] = [];

// Never let a render-init hiccup (e.g. WebGL unavailable) take down the UI —
// the controls must always wire up so the user can pick images.
try {
  await engine.init(stage);
} catch (err) {
  console.error('[slideshow] engine init failed:', err);
}

// Browsers persist <select> / <input> values across page reloads, so the
// initial UI state may differ from the engine's defaults. Sync the engine to
// what the user actually sees in the panel before any folder is loaded.
{
  const trSel    = document.getElementById('transition') as HTMLSelectElement;
  const dwellInp = document.getElementById('dwell') as HTMLInputElement;
  const tdurInp  = document.getElementById('tdur')  as HTMLInputElement;
  engine.setTransition(trSel.value as TransitionId);
  if (+dwellInp.value > 0) engine.setDwell(+dwellInp.value);
  if (+tdurInp.value  > 0) engine.setTDur(+tdurInp.value);
}

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
    if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
    else document.exitFullscreen?.();
  },
  onTransition: (id) => engine.setTransition(id as TransitionId),
  onDwell: (s) => engine.setDwell(s),
  onTDur: (s) => engine.setTDur(s),
  onJump: (i) => engine.jump(i),
});

engine.onSlideChange = (i) => ui.setActive(i);
engine.onPlayingChange = (p) => ui.setPlaying(p);

function loadFiles(name: string, files: ImageEntry[]) {
  if (files.length === 0) {
    alert('No images found in the selected folder.');
    return;
  }
  // "Shuffle on load" toggle — Fisher–Yates shuffle the items array before
  // handing it to the engine, so the slideshow doesn't always start at
  // file #1. Browsers persist the checkbox state across reloads.
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
