import { isIOS, isTouchPrimary, type ImageEntry } from './folder.ts';
import { perfEnabled, perfSetVisible } from './perf.ts';

export interface UIBindings {
  onFilesPicked: (list: FileList) => void;
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

export const WEBGL2_MESSAGE =
  'This browser does not support WebGL2, which is required for daslides.';

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
  private readonly rowHeight = 44;   // iOS touch-target minimum
  private readonly overscan = 6;
  private rafScheduled = false;
  private selfScrolling = false;
  /**
   * Whether the drawer is open. Pushed in from setPanel() rather than probed
   * from the DOM: the closed drawer is hidden with a transform, not display or
   * visibility, so it stays laid out and clientHeight is never 0.
   */
  private visible = false;
  /** Last time the user scrolled the list themselves. */
  private lastUserScroll = 0;
  /** Row the keyboard cursor is on (may be outside the rendered window). */
  private focused = -1;
  /** True once the arrow keys have been used, so playback stops moving focus. */
  private keyboardNav = false;

  constructor(
    private listEl: HTMLDivElement,
    private spacerEl: HTMLDivElement,
    private onJump: (i: number) => void,
  ) {
    this.container = listEl;
    this.spacer = spacerEl;
    this.container.addEventListener('keydown', (e) => this.onListKey(e));
    this.container.addEventListener('scroll', () => {
      // Any scroll we didn't cause ourselves counts as the user taking over.
      if (!this.selfScrolling) this.lastUserScroll = performance.now();
      this.scheduleRender();
    }, { passive: true });
    new ResizeObserver(() => this.scheduleRender()).observe(this.container);
  }

  setItems(items: ImageEntry[]) {
    this.items = items;
    this.spacer.style.height = `${items.length * this.rowHeight}px`;
    for (const row of this.rows.values()) row.remove();
    this.rows.clear();
    this.active = -1;
    this.focused = -1;
    this.keyboardNav = false;
    this.container.scrollTop = 0;
    this.syncAria();
    this.scheduleRender();
  }

  setActive(index: number) {
    if (this.active === index) return;
    const old = this.active;
    this.active = index;
    const oldRow = this.rows.get(old);
    if (oldRow) {
      oldRow.classList.remove('active');
      oldRow.setAttribute('aria-selected', 'false');
    }
    const row = this.rows.get(index);
    if (row) {
      row.classList.add('active');
      row.setAttribute('aria-selected', 'true');
    }
    // Follow playback with the focus marker too, unless the user has taken
    // over with the arrow keys.
    if (!this.keyboardNav) this.focused = index;
    this.syncAria();
    this.scrollIntoView(index);
  }

  /**
   * Move the keyboard cursor. The list is virtualized, so the focused row may
   * not exist in the DOM — aria-activedescendant points at an id that render()
   * assigns when the row scrolls into range, and the container keeps real DOM
   * focus throughout.
   */
  moveFocus(delta: number | 'home' | 'end') {
    if (this.items.length === 0) return;
    const from = this.focused < 0 ? this.active : this.focused;
    const to = delta === 'home' ? 0
      : delta === 'end' ? this.items.length - 1
      : Math.min(this.items.length - 1, Math.max(0, (from < 0 ? 0 : from) + delta));
    this.keyboardNav = true;
    this.rows.get(this.focused)?.classList.remove('focused');
    this.focused = to;
    // A deliberate move should scroll, even if the user scrolled a moment ago.
    this.lastUserScroll = 0;
    this.scrollIntoView(to);
    this.render();
    this.rows.get(to)?.classList.add('focused');
    this.syncAria();
  }

  /** Jump to whichever row the keyboard cursor is on. */
  activateFocused() {
    if (this.focused >= 0) this.onJump(this.focused);
  }

  private syncAria() {
    const id = this.focused >= 0 ? `vrow-${this.focused}` : '';
    if (id) this.container.setAttribute('aria-activedescendant', id);
    else this.container.removeAttribute('aria-activedescendant');
  }

  setVisible(v: boolean) {
    this.visible = v;
    if (v) this.scheduleRender();
  }

  private scrollIntoView(i: number) {
    if (i < 0) return;
    // Off-screen: don't touch scrollTop. Writing it fires a scroll event ->
    // scheduleRender() -> a rAF that recycles rows, landing DOM work on the
    // transition's second frame for something nobody can see.
    if (!this.visible) return;
    // Don't fight the user. If they scrolled recently they're looking for a
    // photo; yanking the list back to the active row is hostile.
    if (performance.now() - this.lastUserScroll < 2000) return;
    const viewH = this.container.clientHeight;
    if (viewH === 0) return;
    const top = i * this.rowHeight;
    const bot = top + this.rowHeight;
    const sTop = this.container.scrollTop;
    const to = top < sTop ? top : bot > sTop + viewH ? bot - viewH : null;
    if (to === null) return;
    this.selfScrolling = true;
    this.container.scrollTop = to;
    this.selfScrolling = false;
  }

  private onListKey(e: KeyboardEvent) {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    switch (e.key) {
      case 'ArrowDown':  e.preventDefault(); e.stopPropagation(); this.moveFocus(1); break;
      case 'ArrowUp':    e.preventDefault(); e.stopPropagation(); this.moveFocus(-1); break;
      case 'PageDown':   e.preventDefault(); e.stopPropagation(); this.moveFocus(10); break;
      case 'PageUp':     e.preventDefault(); e.stopPropagation(); this.moveFocus(-10); break;
      case 'Home':       e.preventDefault(); e.stopPropagation(); this.moveFocus('home'); break;
      case 'End':        e.preventDefault(); e.stopPropagation(); this.moveFocus('end'); break;
      case 'Enter':
      case ' ':          e.preventDefault(); e.stopPropagation(); this.activateFocused(); break;
    }
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
    if (!this.visible || this.items.length === 0) return;   // nothing to lay out
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
    // Rows are recycled, so every bit of state has to be re-applied here —
    // the same reason `.active` is set below rather than only in setActive().
    row.setAttribute('role', 'option');
    row.id = `vrow-${i}`;
    row.setAttribute('aria-selected', String(i === this.active));
    if (i === this.active) row.classList.add('active');
    if (i === this.focused) row.classList.add('focused');

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

// Must match the min/max attributes on #dwell and #tdur in index.html.
const DWELL_MIN = 2, DWELL_MAX = 60;
const TDUR_MIN = 0.5, TDUR_MAX = 10;

export class UI {
  private body = document.body;

  private panel = $<HTMLElement>('panel');
  private drawerScrim = $<HTMLElement>('drawer-scrim');
  private help = $<HTMLElement>('help');

  private emptyPhotos = $<HTMLLabelElement>('empty-photos');
  private fallback = $<HTMLInputElement>('pick-fallback');
  private photosInput = $<HTMLInputElement>('pick-photos');
  private toastEl = $<HTMLDivElement>('toast');
  private installBtn = $<HTMLButtonElement>('install-btn');
  private deferredPrompt: any = null;
  private toastTimer = 0;
  private folderName = $<HTMLSpanElement>('folder-name');
  private listCount = $<HTMLSpanElement>('list-count');
  private counter = $<HTMLSpanElement>('counter');
  private progressFill = $<HTMLDivElement>('progress-fill');
  private controlsEl = $<HTMLElement>('controls');
  private emptyEl = $<HTMLElement>('empty');

  private trSel = $<HTMLSelectElement>('transition');
  private dwellInp = $<HTMLInputElement>('dwell');
  private tdurInp = $<HTMLInputElement>('tdur');
  private autoHideBox = $<HTMLInputElement>('auto-hide');
  private perfRow = $<HTMLLabelElement>('perf-row');
  private perfBox = $<HTMLInputElement>('perf-toggle');

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
  private tDurSec = 1.5;
  /** Slide-progress bar, driven imperatively so restarts never force layout. */
  private progressAnim: Animation | null = null;
  private isIOS = isIOS();

  constructor(private b: UIBindings) {
    this.vlist = new VirtualList($('list'), $('list-spacer'), (i) => {
      b.onJump(i);
      this.setPanel(false); // jumping is a "go look at it" action — get out of the way
    });

    this.dwellSec = this.commitNumber(this.dwellInp, DWELL_MIN, DWELL_MAX, 10);
    this.tDurSec = this.commitNumber(this.tdurInp, TDUR_MIN, TDUR_MAX, 1.5);

    // On touch devices `webkitdirectory` (folder picking) doesn't work — CSS
    // hides the folder label, so promote the photo label to the primary action.
    const touch = isTouchPrimary();
    this.body.classList.toggle('touch', touch);
    if (touch) this.emptyPhotos.textContent = 'Choose photos…';

    // Pickers are native <label for> → file input; we only react to the result.
    const onChange = (input: HTMLInputElement) => () => {
      if (input.files && input.files.length) b.onFilesPicked(input.files);
      // Clear both, so re-picking the same folder still fires `change` (a
      // natural thing to try when you want to restart) and neither input keeps
      // thousands of File handles alive.
      this.fallback.value = '';
      this.photosInput.value = '';
    };
    this.fallback.addEventListener('change', onChange(this.fallback));
    this.photosInput.addEventListener('change', onChange(this.photosInput));

    // Mirror each input's keyboard focus onto the label(s) that point at it, so
    // the pickers have a visible focus ring. CSS can't do this: the labels are
    // neither siblings nor children of the inputs, which sit at the end of the
    // document. Matching :focus-visible keeps the ring off mouse clicks.
    for (const input of [this.fallback, this.photosInput]) {
      const labels = [...document.querySelectorAll<HTMLElement>(`label[for="${input.id}"]`)];
      input.addEventListener('focus', () => {
        if (input.matches(':focus-visible')) {
          for (const l of labels) l.classList.add('focus-ring');
        }
      });
      input.addEventListener('blur', () => {
        for (const l of labels) l.classList.remove('focus-ring');
      });
    }

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
      this.dwellSec = this.commitNumber(this.dwellInp, DWELL_MIN, DWELL_MAX, this.dwellSec);
      b.onDwell(this.dwellSec);
      this.restartProgress();
    });
    this.tdurInp.addEventListener('change', () => {
      this.tDurSec = this.commitNumber(this.tdurInp, TDUR_MIN, TDUR_MAX, this.tDurSec);
      b.onTDur(this.tDurSec);
      this.restartProgress();
    });

    window.addEventListener('keydown', (e) => this.onKey(e));

    const onFsChange = () => {
      this.body.classList.toggle('fullscreen',
        !!(document.fullscreenElement || (document as any).webkitFullscreenElement));
      this.syncFullscreenLabel();
    };
    document.addEventListener('fullscreenchange', onFsChange);
    document.addEventListener('webkitfullscreenchange', onFsChange);

    this.syncFullscreenLabel();
    this.setupPwa();

    // Activity wakes the controls. pointerdown/touchstart are essential on
    // touch devices (no mousemove) — without them the controls can never be
    // re-shown once the idle timer hides them.
    window.addEventListener('mousemove', () => this.wake(), { passive: true });
    window.addEventListener('keydown', () => this.wake(), { passive: true });
    window.addEventListener('pointerdown', () => this.wake(), { passive: true });
    window.addEventListener('touchstart', () => this.wake(), { passive: true });
    this.panel.addEventListener('mouseenter', () => this.wake());
    this.panel.addEventListener('focusin', () => this.wake());
    this.autoHideBox.addEventListener('change', () => this.wake());

    // The overlay is opt-in via ?perf=1. Without the flag, DELETE the row rather
    // than hiding it: the `hidden` attribute works through the UA rule
    // `[hidden] { display: none }`, which any author `display` beats — and
    // `.toggle` sets `display: flex`. So the row stayed on screen with no
    // listener attached, which is a control that looks live and does nothing.
    // A row that isn't in the DOM can't come back as a dead control, whatever
    // happens to the stylesheet later.
    if (perfEnabled) {
      this.perfRow.hidden = false;
      perfSetVisible(this.perfBox.checked);
      this.perfBox.addEventListener('change', () => {
        perfSetVisible(this.perfBox.checked);
        this.wake();
      });
    } else {
      this.perfRow.remove();
    }

    this.wake();
  }

  private get panelOpen() { return this.body.classList.contains('panel-open'); }
  private get helpOpen() { return !this.help.hidden; }

  private onKey(e: KeyboardEvent) {
    // Escape first, before the typing guard: the drawer's own button is
    // labelled "Close · Esc", so it has to work from a focused field too.
    if (e.key === 'Escape') {
      if (this.helpOpen) { this.setHelp(false); return; }
      if (this.panelOpen) { this.setPanel(false); return; }
      const doc = document as any;
      if (document.fullscreenElement) document.exitFullscreen();
      else if (doc.webkitFullscreenElement) doc.webkitExitFullscreen?.();
      return;
    }

    // Never hijack a browser or OS chord. Without this, Cmd+F goes fullscreen,
    // Cmd+S opens the drawer behind the save dialog, and Alt+Left blocks Back.
    if (e.metaKey || e.ctrlKey || e.altKey) return;

    // Don't fire while typing, and don't steal keys from a focused control:
    // Space and Enter must activate the button, not the shortcut.
    const t = e.target as HTMLElement | null;
    if (
      t instanceof HTMLInputElement ||
      t instanceof HTMLSelectElement ||
      t instanceof HTMLTextAreaElement ||
      t?.closest('button, [role="option"]')
    ) return;

    if (e.key === '?') { e.preventDefault(); this.setHelp(!this.helpOpen); return; }

    switch (e.key) {
      case ' ': e.preventDefault(); this.b.onPlayToggle(); break;
      case 'ArrowLeft': e.preventDefault(); this.b.onPrev(); break;
      case 'ArrowRight': e.preventDefault(); this.b.onNext(); break;
      case 'f': case 'F': this.b.onFullscreen(); break;
      // Gated on hasFolder: the drawer sits behind the welcome screen, so
      // opening it there looks like nothing happened while leaving it focusable.
      case 's': case 'S': if (this.hasFolder) this.setPanel(!this.panelOpen); break;
    }
  }

  private setPanel(open: boolean) {
    this.body.classList.toggle('panel-open', open);
    // `inert` (not aria-hidden) for the closed drawer: it removes the subtree
    // from focus + assistive tech without the Chromium "aria-hidden on a focused
    // descendant" conflict.
    this.panel.inert = !open;
    this.settingsBtn.setAttribute('aria-expanded', String(open));
    this.vlist.setVisible(open);
    // Match what setHelp already does: move focus in on open, hand it back on
    // close. Without this, closing the drawer made `inert` destroy the focus and
    // reset it to <body>.
    if (open) $<HTMLButtonElement>('panel-toggle').focus();
    else if (this.hasFolder && this.panel.contains(document.activeElement)) {
      this.settingsBtn.focus();
    }
    // Unconditionally, not just on open: wake() bails while the drawer is open,
    // so only calling it there left the controls visible forever after a close.
    this.wake();
  }

  private setHelp(open: boolean) {
    this.help.hidden = !open;
    // aria-modal only tells AT the dialog is modal; it doesn't stop Tab. Make
    // everything behind it genuinely unreachable.
    this.controlsEl.inert = open;
    this.emptyEl.inert = open;
    if (open) {
      $<HTMLButtonElement>('help-close').focus();
    } else if (this.hasFolder) {
      // Only restore focus to a button the user can actually see.
      this.helpBtn.focus();
    }
    this.wake();
  }

  /**
   * Read a number input, clamp it to the same bounds the markup advertises,
   * and write the clamped value back so the field shows what is in effect.
   *
   * The min/max attributes only drive the spinner, so without this an empty or
   * out-of-range field reached the engine and got clamped there instead — the
   * UI and the engine then disagreed and the progress bar drifted from the real
   * slide length for good.
   */
  private commitNumber(
    input: HTMLInputElement, min: number, max: number, fallback: number,
  ): number {
    const raw = +input.value;
    const v = Number.isFinite(raw) && raw > 0
      ? Math.min(max, Math.max(min, raw))
      : fallback;
    input.value = String(v);
    return v;
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

  /**
   * Install / Add-to-Home-Screen wiring. iPhone has no element Fullscreen API,
   * so the immersive experience there is a standalone home-screen app; Android
   * gets the same via the install prompt.
   */
  private setupPwa() {
    const standalone =
      (navigator as any).standalone === true ||
      matchMedia('(display-mode: standalone)').matches ||
      matchMedia('(display-mode: fullscreen)').matches;
    if (standalone) {
      this.body.classList.add('standalone'); // already immersive — hide FS + install
      return;
    }

    // Android / desktop Chromium: capture the prompt and offer "Install app".
    window.addEventListener('beforeinstallprompt', (e: Event) => {
      e.preventDefault();
      this.deferredPrompt = e;
      this.installBtn.textContent = 'Install app';
      this.installBtn.hidden = false;
    });
    window.addEventListener('appinstalled', () => {
      this.deferredPrompt = null;
      this.installBtn.hidden = true;
      this.toast('Installed — launch it from your home screen.');
    });

    // iOS can't fire beforeinstallprompt — surface a manual entry.
    if (this.isIOS) {
      this.installBtn.textContent = 'Add to Home Screen';
      this.installBtn.hidden = false;
    }

    this.installBtn.addEventListener('click', async () => {
      if (this.deferredPrompt) {
        this.deferredPrompt.prompt();
        try { await this.deferredPrompt.userChoice; } catch {}
        this.deferredPrompt = null;
        this.installBtn.hidden = true;
      } else {
        this.showInstallHint();
      }
    });
  }

  /** Toast the platform-appropriate way to install / go fullscreen. */
  showInstallHint() {
    this.toast(
      this.isIOS
        ? 'For fullscreen on iPhone: tap Share, then “Add to Home Screen”.'
        : 'Install from your browser menu → “Install app” / “Add to Home Screen”.',
    );
  }

  toast(msg: string) {
    this.toastEl.textContent = msg;
    this.toastEl.hidden = false;
    this.toastEl.classList.remove('show');
    // Next frame, so removing and re-adding the class actually restarts the
    // transition. (Reading offsetWidth would do it too, at the cost of a forced
    // layout.)
    requestAnimationFrame(() => this.toastEl.classList.add('show'));
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      this.toastEl.classList.remove('show');
      this.toastTimer = window.setTimeout(() => { this.toastEl.hidden = true; }, 300);
    }, 4200);
  }

  private syncFullscreenLabel() {
    const on = this.body.classList.contains('fullscreen');
    this.fsBtn.setAttribute('aria-label', on ? 'Exit fullscreen' : 'Fullscreen');
    this.fsBtn.setAttribute('aria-pressed', String(on));
    this.fsBtn.title = on ? 'Exit fullscreen · F' : 'Fullscreen · F';
  }

  setPlaying(playing: boolean) {
    this.playing = playing;
    this.body.classList.toggle('playing', playing);
    this.playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
    this.playBtn.setAttribute('aria-pressed', String(playing));
    if (this.progressAnim) { if (playing) this.progressAnim.play(); else this.progressAnim.pause(); }
  }

  /**
   * Renderer is unusable — say so and take away every way to pick photos,
   * including the two in the drawer, so the user can't walk into a black screen.
   */
  showFatal(msg: string) {
    const sub = document.querySelector('.empty__sub');
    if (sub) sub.textContent = msg;
    for (const id of ['empty-folder', 'empty-photos', 'pick-folder', 'pick-photos-btn']) {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    }
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
  /**
   * Restart the slide-progress bar.
   *
   * This runs on every slide change, which is the same instant a transition
   * starts — so it must not touch layout. The old implementation restarted a
   * CSS animation via the `void offsetWidth` reflow trick, forcing a synchronous
   * full-document layout right when the renderer needs the frame budget. A Web
   * Animations object restarts by setting `currentTime`, which costs nothing.
   *
   * Duration is the real cycle (`dwell + fade`), not `dwell` — otherwise the bar
   * fills early and then sits full, reading as "stuck".
   */
  private restartProgress() {
    const durMs = (this.dwellSec + this.tDurSec) * 1000;
    if (!this.progressAnim) {
      this.progressAnim = this.progressFill.animate(
        [{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }],
        { duration: durMs, easing: 'linear', fill: 'forwards' },
      );
    } else {
      this.progressAnim.effect?.updateTiming({ duration: durMs });
    }
    this.progressAnim.currentTime = 0;
    if (this.playing) this.progressAnim.play();
    else this.progressAnim.pause();
  }
}
