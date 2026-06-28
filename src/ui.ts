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
  private readonly rowHeight = 26;
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
    // Drop every row — fresh start
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

  /** Scroll the given index into view if it's outside the viewport. */
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

    // Recycle rows that scrolled out
    for (const [i, row] of this.rows) {
      if (i < start || i >= end) {
        row.remove();
        this.rows.delete(i);
      }
    }

    // Add rows that scrolled in
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

export class UI {
  private root = document.getElementById('panel')!;
  private toggleBtn = document.getElementById('panel-toggle') as HTMLButtonElement;
  private showBtn = document.getElementById('panel-show') as HTMLButtonElement;

  private pickBtn = document.getElementById('pick-folder') as HTMLButtonElement;
  private fallback = document.getElementById('pick-fallback') as HTMLInputElement;
  private folderName = document.getElementById('folder-name') as HTMLSpanElement;
  private listCount = document.getElementById('list-count') as HTMLSpanElement;

  private trSel = document.getElementById('transition') as HTMLSelectElement;
  private dwellInp = document.getElementById('dwell') as HTMLInputElement;
  private tdurInp = document.getElementById('tdur') as HTMLInputElement;

  private playBtn = document.getElementById('play') as HTMLButtonElement;
  private prevBtn = document.getElementById('prev') as HTMLButtonElement;
  private nextBtn = document.getElementById('next') as HTMLButtonElement;
  private shuffleBtn = document.getElementById('shuffle') as HTMLButtonElement;
  private fsBtn = document.getElementById('fullscreen') as HTMLButtonElement;

  private vlist: VirtualList;

  private idleTimer = 0;

  constructor(private b: UIBindings) {
    this.vlist = new VirtualList(
      document.getElementById('list') as HTMLDivElement,
      document.getElementById('list-spacer') as HTMLDivElement,
      (i) => b.onJump(i),
    );

    this.pickBtn.addEventListener('click', () => b.onPickFolder());
    this.fallback.addEventListener('change', () => {
      if (this.fallback.files && this.fallback.files.length) b.onFallbackPicked(this.fallback.files);
    });

    this.playBtn.addEventListener('click', () => b.onPlayToggle());
    this.prevBtn.addEventListener('click', () => b.onPrev());
    this.nextBtn.addEventListener('click', () => b.onNext());
    this.shuffleBtn.addEventListener('click', () => b.onShuffle());
    this.fsBtn.addEventListener('click', () => b.onFullscreen());

    this.trSel.addEventListener('change', () => b.onTransition(this.trSel.value));
    this.dwellInp.addEventListener('change', () => b.onDwell(+this.dwellInp.value));
    this.tdurInp.addEventListener('change', () => b.onTDur(+this.tdurInp.value));

    this.toggleBtn.addEventListener('click', () => this.setOpen(false));
    this.showBtn.addEventListener('click', () => this.setOpen(true));

    window.addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return;
      switch (e.key) {
        case ' ': e.preventDefault(); b.onPlayToggle(); break;
        case 'ArrowLeft': b.onPrev(); break;
        case 'ArrowRight': b.onNext(); break;
        case 'f': case 'F': b.onFullscreen(); break;
        case 'p': case 'P': this.setOpen(!this.root.classList.contains('open')); break;
        case 'Escape':
          if (document.fullscreenElement) document.exitFullscreen();
          break;
      }
    });

    document.addEventListener('fullscreenchange', () => {
      document.body.classList.toggle('fullscreen', !!document.fullscreenElement);
    });

    window.addEventListener('mousemove', () => this.wake());
    this.wake();
  }

  private wake() {
    document.body.classList.remove('idle');
    clearTimeout(this.idleTimer);
    this.idleTimer = window.setTimeout(() => {
      if (document.fullscreenElement) document.body.classList.add('idle');
    }, 2500);
  }

  setOpen(open: boolean) {
    this.root.classList.toggle('open', open);
    this.showBtn.hidden = open;
  }

  setPlaying(playing: boolean) {
    this.playBtn.textContent = playing ? '❚❚ Pause' : '▶︎ Play';
  }

  setFolderName(name: string) {
    this.folderName.textContent = name;
    this.folderName.classList.remove('muted');
  }

  setActive(index: number) {
    this.vlist.setActive(index);
  }

  renderList(items: ImageEntry[]) {
    this.listCount.textContent = items.length === 1 ? '1 image' : `${items.length.toLocaleString()} images`;
    this.vlist.setItems(items);
  }
}
