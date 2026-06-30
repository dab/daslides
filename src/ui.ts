import type { ImageEntry } from './folder.ts';

export interface UIBindings {
  onPickFolder: () => void;
  onFallbackPicked: (list: FileList) => void;
  onPlayToggle: () => void;
  onPrev: () => void;
  onNext: () => void;
  onShuffle: () => void;
  onFullscreen: () => void;
  onTransition: (id: string) => void;
  onDwell: (sec: number) => void;
  onTDur: (sec: number) => void;
  onJump: (index: number) => void;
}

/**
 * Virtualized side-panel list — only ~30 rows live in the DOM at any time,
 * so the side panel stays smooth at 10k+ photos. The list itself is a
 * positioned spacer of total height (items.length × rowHeight); rows are
 * absolutely positioned by index. setActive() is O(1) — it swaps a CSS class
 * on at most two rendered rows.
 */
class VirtualList {
  private container: HTMLDivElement;
  private spacer: HTMLDivElement;
  private items: ImageEntry[] = [];
  private rows = new Map<number, HTMLDivElement>();
  private active = -1;
  private readonly rowHeight = 28;
  private readonly overscan = 6;
  private rafScheduled = false;

  constructor(
    private listEl: HTMLDivElement,
    private spacerEl: HTMLDivElement,
    private onJump: (i: number) => void,
  ) {
    this.container = listEl;
    this.spacer = spacerEl;
    this.container.addEventListener('scroll', () => this.scheduleRender(), { passive: true });
    new ResizeObserver(() => this.scheduleRender()).observe(this.container);
  }

  setItems(items: ImageEntry[]) {
    this.items = items;
    this.spacer.style.height = `${items.length * this.rowHeight}px`;
    for (const row of this.rows.values()) row.remove();
    this.rows.clear();
    this.active = -1;
    this.container.scrollTop = 0;
    this.scheduleRender();
  }

  setActive(index: number) {
    if (this.active === index) return;
    const old = this.active;
    this.active = index;
    if (old >= 0) this.rows.get(old)?.classList.remove('active');
    this.rows.get(index)?.classList.add('active');
    this.scrollIntoView(index);
  }

  private scrollIntoView(i: number) {
    if (i < 0) return;
    const top = i * this.rowHeight;
    const bot = top + this.rowHeight;
    const sTop = this.container.scrollTop;
    const viewH = this.container.clientHeight;
    if (top < sTop) this.container.scrollTop = top;
    else if (bot > sTop + viewH) this.container.scrollTop = bot - viewH;
  }

  private scheduleRender() {
    if (this.rafScheduled) return;
    this.rafScheduled = true;
    requestAnimationFrame(() => {
      this.rafScheduled = false;
      this.render();
    });
  }

  private render() {
    if (this.items.length === 0) return;
    const sTop = this.container.scrollTop;
    const viewH = this.container.clientHeight;
    const start = Math.max(0, Math.floor(sTop / this.rowHeight) - this.overscan);
    const end   = Math.min(this.items.length,
      Math.ceil((sTop + viewH) / this.rowHeight) + this.overscan);

    for (const [i, row] of this.rows) {
      if (i < start || i >= end) {
        row.remove();
        this.rows.delete(i);
      }
    }

    for (let i = start; i < end; i++) {
      if (this.rows.has(i)) continue;
      const row = this.makeRow(i);
      this.spacer.appendChild(row);
      this.rows.set(i, row);
    }
  }

  private makeRow(i: number): HTMLDivElement {
    const row = document.createElement('div');
    row.className = 'vlist-row';
    row.style.top = `${i * this.rowHeight}px`;
    row.style.height = `${this.rowHeight}px`;
    if (i === this.active) row.classList.add('active');

    const idx = document.createElement('span');
    idx.className = 'idx';
    idx.textContent = String(i + 1);

    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = this.items[i].name;

    row.appendChild(idx);
    row.appendChild(name);
    row.addEventListener('click', () => this.onJump(i));
    return row;
  }
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export class UI {
  private body = document.body;

  private panel = $<HTMLElement>('panel');
  private drawerScrim = $<HTMLElement>('drawer-scrim');
  private help = $<HTMLElement>('help');

  private pickBtn = $<HTMLButtonElement>('pick-folder');
  private pickEmptyBtn = $<HTMLButtonElement>('pick-empty');
  private fallback = $<HTMLInputElement>('pick-fallback');
  private folderName = $<HTMLSpanElement>('folder-name');
  private listCount = $<HTMLSpanElement>('list-count');
  private counter = $<HTMLSpanElement>('counter');
  private progressFill = $<HTMLDivElement>('progress-fill');

  private trSel = $<HTMLSelectElement>('transition');
  private dwellInp = $<HTMLInputElement>('dwell');
  private tdurInp = $<HTMLInputElement>('tdur');
  private autoHideBox = $<HTMLInputElement>('auto-hide');

  private playBtn = $<HTMLButtonElement>('play');
  private prevBtn = $<HTMLButtonElement>('prev');
  private nextBtn = $<HTMLButtonElement>('next');
  private shuffleBtn = $<HTMLButtonElement>('shuffle');
  private fsBtn = $<HTMLButtonElement>('fullscreen');
  private settingsBtn = $<HTMLButtonElement>('settings-btn');
  private helpBtn = $<HTMLButtonElement>('help-btn');

  private vlist: VirtualList;

  private idleTimer = 0;
  private hasFolder = false;
  private playing = false;
  private total = 0;
  private dwellSec = 10;

  constructor(private b: UIBindings) {
    this.vlist = new VirtualList($('list'), $('list-spacer'), (i) => {
      b.onJump(i);
      this.setPanel(false); // jumping is a "go look at it" action — get out of the way
    });

    this.dwellSec = +this.dwellInp.value > 0 ? +this.dwellInp.value : 10;

    this.pickBtn.addEventListener('click', () => b.onPickFolder());
    this.pickEmptyBtn.addEventListener('click', () => b.onPickFolder());
    this.fallback.addEventListener('change', () => {
      if (this.fallback.files && this.fallback.files.length) b.onFallbackPicked(this.fallback.files);
    });

    this.playBtn.addEventListener('click', () => b.onPlayToggle());
    this.prevBtn.addEventListener('click', () => b.onPrev());
    this.nextBtn.addEventListener('click', () => b.onNext());
    this.shuffleBtn.addEventListener('click', () => b.onShuffle());
    this.fsBtn.addEventListener('click', () => b.onFullscreen());
    this.settingsBtn.addEventListener('click', () => this.setPanel(!this.panelOpen));
    this.helpBtn.addEventListener('click', () => this.setHelp(!this.helpOpen));

    $<HTMLButtonElement>('panel-toggle').addEventListener('click', () => this.setPanel(false));
    $<HTMLButtonElement>('help-close').addEventListener('click', () => this.setHelp(false));
    this.drawerScrim.addEventListener('click', () => this.setPanel(false));
    this.help.addEventListener('click', (e) => { if (e.target === this.help) this.setHelp(false); });

    this.trSel.addEventListener('change', () => b.onTransition(this.trSel.value));
    this.dwellInp.addEventListener('change', () => {
      const v = +this.dwellInp.value;
      if (v > 0) { this.dwellSec = v; b.onDwell(v); }
    });
    this.tdurInp.addEventListener('change', () => b.onTDur(+this.tdurInp.value));

    window.addEventListener('keydown', (e) => this.onKey(e));

    document.addEventListener('fullscreenchange', () => {
      this.body.classList.toggle('fullscreen', !!document.fullscreenElement);
    });

    // Activity wakes the controls.
    window.addEventListener('mousemove', () => this.wake(), { passive: true });
    window.addEventListener('keydown', () => this.wake(), { passive: true });
    this.panel.addEventListener('mouseenter', () => this.wake());
    this.panel.addEventListener('focusin', () => this.wake());
    this.autoHideBox.addEventListener('change', () => this.wake());

    this.wake();
  }

  private get panelOpen() { return this.body.classList.contains('panel-open'); }
  private get helpOpen() { return !this.help.hidden; }

  private onKey(e: KeyboardEvent) {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;

    if (e.key === 'Escape') {
      if (this.helpOpen) { this.setHelp(false); return; }
      if (this.panelOpen) { this.setPanel(false); return; }
      if (document.fullscreenElement) document.exitFullscreen();
      return;
    }
    if (e.key === '?') { e.preventDefault(); this.setHelp(!this.helpOpen); return; }

    switch (e.key) {
      case ' ': e.preventDefault(); this.b.onPlayToggle(); break;
      case 'ArrowLeft': e.preventDefault(); this.b.onPrev(); break;
      case 'ArrowRight': e.preventDefault(); this.b.onNext(); break;
      case 'f': case 'F': this.b.onFullscreen(); break;
      case 's': case 'S': this.setPanel(!this.panelOpen); break;
    }
  }

  private setPanel(open: boolean) {
    this.body.classList.toggle('panel-open', open);
    this.panel.setAttribute('aria-hidden', open ? 'false' : 'true');
    if (open) this.wake();
  }

  private setHelp(open: boolean) {
    this.help.hidden = !open;
    if (open) {
      $<HTMLButtonElement>('help-close').focus();
      this.wake();
    } else {
      this.helpBtn.focus();
    }
  }

  private autoHideEnabled(): boolean { return this.autoHideBox.checked; }

  private wake() {
    this.body.classList.remove('idle');
    clearTimeout(this.idleTimer);
    if (!this.hasFolder || !this.autoHideEnabled()) return;
    if (this.panelOpen || this.helpOpen) return;
    this.idleTimer = window.setTimeout(() => {
      if (this.panelOpen || this.helpOpen) return;
      if (this.panel.contains(document.activeElement)) return; // keyboard users
      this.body.classList.add('idle');
    }, 2500);
  }

  setPlaying(playing: boolean) {
    this.playing = playing;
    this.body.classList.toggle('playing', playing);
    this.playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    this.progressFill.style.animationPlayState = playing ? 'running' : 'paused';
  }

  setFolderName(name: string) {
    this.folderName.textContent = name;
    this.hasFolder = true;
    this.body.classList.add('has-folder');
    this.setPanel(false); // reveal the photos once a folder is chosen
    this.wake();
  }

  setActive(index: number) {
    this.vlist.setActive(index);
    this.updateCounter(index);
    this.restartProgress();
  }

  renderList(items: ImageEntry[]) {
    this.total = items.length;
    this.listCount.textContent = items.length === 1 ? '1 image' : `${items.length.toLocaleString()} images`;
    this.vlist.setItems(items);
  }

  private updateCounter(index: number) {
    if (this.total === 0) { this.counter.textContent = '—— / ——'; return; }
    const width = String(this.total).length;
    this.counter.textContent = `${String(index + 1).padStart(width, '0')} / ${this.total}`;
  }

  /** Restart the dwell-progress bar so it grows over one dwell period. */
  private restartProgress() {
    const f = this.progressFill;
    f.style.animation = 'none';
    void f.offsetWidth; // force reflow so the animation restarts
    f.style.animation = `progressGrow ${this.dwellSec}s linear forwards`;
    f.style.animationPlayState = this.playing ? 'running' : 'paused';
  }
}
