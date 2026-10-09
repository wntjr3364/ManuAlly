// Autosave for the manuscript editor (spec 04 "저장·접근성"). Framework-free so it can be tested
// with fake timers. Rules:
// - one request at a time; a save starts after typing pauses (idleMs) or at the latest after maxWaitMs
// - never during an IME composition: the save waits until the composition ends
// - "저장됨" only through saveReducer's acknowledgement rules (save-state.ts)
// - after a network/server failure the identical request is sent again first (the server answers a
//   resend of a save it already stored as stored), then the newer text
// - a conflict stops autosave (nothing is overwritten); a rejected save waits for the next edit
import type { SaveAction } from '../features/paper/save-state.ts';

export interface SaveRequest { version: number; json: unknown; key: string; expectedHead: string }
export type SendResult =
  | { ok: true; headRevisionId: string }
  | { ok: false; kind: 'conflict' | 'rejected' | 'network' | 'server'; message: string };
export type Snapshot = { json: unknown; key: string } | { invalid: string[] };

export interface AutosaveOptions {
  headRevisionId: string;
  // comparison key of the stored content (e.g. canonical JSON); equal keys need no new revision
  savedKey: string;
  idleMs?: number;
  maxWaitMs?: number;
  retryMs?: number[];
  snapshot: () => Snapshot;
  isComposing: () => boolean;
  send: (req: SaveRequest) => Promise<SendResult>;
  dispatch: (a: SaveAction) => void;
  onInvalid?: (errors: string[]) => void;
  onSaved?: (req: SaveRequest, headRevisionId: string) => void;
}

type Timer = ReturnType<typeof setTimeout>;

export class Autosave {
  readonly #o: AutosaveOptions;
  #version = 0;
  #ackedVersion = 0;
  #head: string;
  #savedKey: string;
  #inFlight: SaveRequest | null = null;
  #retry: SaveRequest | null = null; // unanswered request; resent unchanged before anything newer
  #attempt = 0;
  #stopped = false; // conflict: the user has to reload
  #rejectedVersion = -1;
  #due = false; // a save was wanted while busy or composing
  #idle: Timer | null = null;
  #max: Timer | null = null;
  #retryTimer: Timer | null = null;
  #disposed = false;

  constructor(o: AutosaveOptions) {
    this.#o = o;
    this.#head = o.headRevisionId;
    this.#savedKey = o.savedKey;
  }

  get version() { return this.#version; }
  get headRevisionId() { return this.#head; }

  // call after every document change made in the editor
  edit(): void {
    if (this.#disposed) return;
    this.#version += 1;
    this.#o.dispatch({ type: 'edit' });
    this.#schedule();
  }

  // explicit save (button, Ctrl/Cmd+S)
  saveNow(): void {
    this.#clearWaits();
    void this.#run('now');
  }

  compositionEnded(): void {
    if (this.#due && !this.#inFlight && !this.#retryTimer) this.#schedule();
  }

  // the browser reports the network is back: retry a failed request at once
  online(): void {
    if (this.#retry && !this.#inFlight) {
      if (this.#retryTimer) clearTimeout(this.#retryTimer);
      this.#retryTimer = null;
      void this.#run('now');
    }
  }

  dispose(): void {
    this.#disposed = true;
    this.#clearWaits();
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
  }

  #clearWaits() {
    if (this.#idle) clearTimeout(this.#idle);
    if (this.#max) clearTimeout(this.#max);
    this.#idle = this.#max = null;
  }

  #schedule() {
    if (this.#disposed || this.#stopped) return;
    if (this.#idle) clearTimeout(this.#idle);
    this.#idle = setTimeout(() => void this.#run('auto'), this.#o.idleMs ?? 1500);
    this.#max ??= setTimeout(() => void this.#run('auto'), this.#o.maxWaitMs ?? 10_000);
  }

  // 'auto': typing paused; 'now': explicit save, network back or retry timer
  async #run(trigger: 'auto' | 'now'): Promise<void> {
    this.#clearWaits();
    if (this.#disposed || this.#stopped) return;
    // while a failed request waits for its retry, typing pauses do not resend it early
    if (this.#inFlight || this.#o.isComposing() || (trigger === 'auto' && this.#retryTimer)) {
      this.#due = true;
      return;
    }
    this.#due = false;
    let req = this.#retry;
    if (!req) {
      if (this.#version === this.#ackedVersion || this.#version === this.#rejectedVersion) return;
      const snap = this.#o.snapshot();
      if ('invalid' in snap) {
        this.#o.onInvalid?.(snap.invalid);
        return;
      }
      const version = this.#version;
      if (snap.key === this.#savedKey) {
        // back to the stored text: nothing to store
        this.#ackedVersion = version;
        this.#o.dispatch({ type: 'saveStart', version });
        this.#o.dispatch({ type: 'saveOk', version, headRevisionId: this.#head });
        return;
      }
      req = { version, json: snap.json, key: snap.key, expectedHead: this.#head };
    }
    this.#inFlight = req;
    this.#o.dispatch({ type: 'saveStart', version: req.version });
    let res: SendResult;
    try {
      res = await this.#o.send(req);
    } catch (e) {
      res = { ok: false, kind: 'network', message: e instanceof Error ? e.message : String(e) };
    }
    this.#inFlight = null;
    if (this.#disposed) return;
    if (res.ok) {
      this.#retry = null;
      this.#attempt = 0;
      this.#head = res.headRevisionId;
      this.#savedKey = req.key;
      this.#ackedVersion = req.version;
      this.#o.dispatch({ type: 'saveOk', version: req.version, headRevisionId: res.headRevisionId });
      this.#o.onSaved?.(req, res.headRevisionId);
      if (this.#version !== req.version) this.#schedule();
      return;
    }
    this.#o.dispatch({ type: 'saveFailed', version: req.version, error: res.message, conflict: res.kind === 'conflict' });
    if (res.kind === 'conflict') {
      this.#retry = null;
      this.#stopped = true;
      return;
    }
    if (res.kind === 'rejected') {
      this.#retry = null;
      this.#rejectedVersion = req.version;
      if (this.#version !== req.version) this.#schedule();
      return;
    }
    // network or server error: the request may or may not have been stored; send it again unchanged
    this.#retry = req;
    const waits = this.#o.retryMs ?? [2000, 4000, 8000, 15_000, 30_000];
    const wait = waits[Math.min(this.#attempt, waits.length - 1)]!;
    this.#attempt += 1;
    this.#retryTimer = setTimeout(() => { this.#retryTimer = null; void this.#run('now'); }, wait);
  }
}
