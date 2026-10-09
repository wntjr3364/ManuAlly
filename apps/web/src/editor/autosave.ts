// Autosave for the manuscript editor (spec 04 "저장·접근성"). Framework-free so it can be tested
// with fake timers. Rules:
// - one request at a time; a save starts after typing pauses (idleMs) or at the latest after maxWaitMs
// - never during an IME composition: the save waits until the composition ends; a save that should
//   not wait (explicit save, maximum wait reached) then runs at once
// - "저장됨" only through saveReducer's acknowledgement rules (save-state.ts)
// - after a network/server failure the identical request is sent again first (the server answers a
//   resend of a save it already stored as stored), then the newer text. Until that resend is
//   answered, what the server holds is unknown: no shortcut ever marks the screen as saved.
// - a conflict stops autosave (nothing is overwritten)
// - a rejected new save is not retried automatically until the next edit; a rejected resend (e.g. the
//   login expired) stays pending and is sent again by an explicit save or when the network is back
import type { SaveAction } from '../features/paper/save-state.ts';

export interface SaveRequest { version: number; json: unknown; key: string; expectedHead: string; manual: boolean }
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
// auto: typing paused; max: maximum wait reached; retry: backoff timer or network back; manual: explicit save
type Trigger = 'auto' | 'max' | 'retry' | 'manual';

export class Autosave {
  readonly #o: AutosaveOptions;
  #version = 0;
  #ackedVersion = 0;
  #head: string;
  #savedKey: string | null; // null: unknown (a request's outcome was not heard)
  #inFlight: SaveRequest | null = null;
  #retry: SaveRequest | null = null; // unanswered request; resent unchanged before anything newer
  #held = false; // the pending resend was rejected; only an explicit save or the network coming back resends it
  #attempt = 0;
  #stopped = false; // conflict: the user has to reload
  #rejectedVersion = -1;
  #due = false; // a save was wanted while busy or composing
  #urgent: Trigger | null = null; // a save that should not wait, deferred while busy or composing
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
    void this.#run('manual');
  }

  compositionEnded(): void {
    if (this.#inFlight || this.#disposed) return;
    if (this.#urgent) void this.#run(this.#urgent);
    else if (this.#due && !this.#retryTimer && !this.#held) this.#schedule();
  }

  // the browser reports the network is back: resend a pending request at once
  online(): void {
    if (this.#retry && !this.#inFlight) void this.#run('retry');
  }

  // the page regained focus or became visible (e.g. after logging in again in another tab):
  // a held request is tried once more
  resume(): void {
    if (this.#held && !this.#inFlight) void this.#run('retry');
  }

  dispose(): void {
    this.#disposed = true;
    this.#clearWaits();
    this.#clearRetryTimer();
  }

  #clearWaits() {
    if (this.#idle) clearTimeout(this.#idle);
    if (this.#max) clearTimeout(this.#max);
    this.#idle = this.#max = null;
  }

  #clearRetryTimer() {
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
  }

  #schedule() {
    if (this.#disposed || this.#stopped) return;
    if (this.#idle) clearTimeout(this.#idle);
    this.#idle = setTimeout(() => void this.#run('auto'), this.#o.idleMs ?? 1500);
    this.#max ??= setTimeout(() => void this.#run('max'), this.#o.maxWaitMs ?? 10_000);
  }

  async #run(trigger: Trigger): Promise<void> {
    if (this.#disposed || this.#stopped) return;
    const urgent = trigger !== 'auto';
    if (this.#inFlight || this.#o.isComposing()) {
      this.#due = true;
      if (urgent && this.#urgent !== 'manual') this.#urgent = trigger;
      if (!this.#inFlight) this.#clearWaits();
      return;
    }
    // while a failed request waits for its retry (or was rejected), typing does not resend it
    if ((trigger === 'auto' || trigger === 'max') && (this.#retryTimer || this.#held)) {
      this.#due = true;
      this.#clearWaits();
      return;
    }
    this.#clearWaits();
    this.#clearRetryTimer();
    this.#due = false;
    this.#urgent = null;
    this.#held = false;
    let req = this.#retry;
    if (!req) {
      if (this.#version === this.#ackedVersion) return;
      if (this.#version === this.#rejectedVersion && trigger !== 'manual') return;
      const snap = this.#o.snapshot();
      if ('invalid' in snap) {
        this.#o.onInvalid?.(snap.invalid);
        return;
      }
      const version = this.#version;
      if (this.#savedKey !== null && snap.key === this.#savedKey) {
        // back to the text the server is known to hold: nothing to store
        this.#ackedVersion = version;
        this.#o.dispatch({ type: 'saveStart', version });
        this.#o.dispatch({ type: 'saveOk', version, headRevisionId: this.#head });
        return;
      }
      req = { version, json: snap.json, key: snap.key, expectedHead: this.#head, manual: trigger === 'manual' };
    }
    const resend = req === this.#retry;
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
      if (this.#urgent) void this.#run(this.#urgent);
      else if (this.#version !== req.version) this.#schedule();
      return;
    }
    const hold = res.kind === 'rejected' && resend;
    this.#o.dispatch({ type: 'saveFailed', version: req.version, error: res.message, conflict: res.kind === 'conflict', blocked: hold });
    if (res.kind === 'conflict') {
      this.#retry = null;
      this.#stopped = true;
      return;
    }
    if (res.kind === 'rejected') {
      if (hold) {
        // an earlier answer was lost, so the server may already hold this request: keep it pending.
        // Saves queued meanwhile are dropped: only an explicit save, focus or the network resends it.
        this.#held = true;
        this.#urgent = null;
        this.#due = false;
        return;
      }
      // a new save the server refused (nothing stored); the next edit or an explicit save tries again
      this.#retry = null;
      this.#rejectedVersion = req.version;
      if (this.#version !== req.version) this.#schedule();
      return;
    }
    // network or server error: the request may or may not have been stored; send it again unchanged
    this.#retry = req;
    this.#savedKey = null; // second guard: the pending resend already goes before any shortcut
    const waits = this.#o.retryMs ?? [2000, 4000, 8000, 15_000, 30_000];
    const wait = waits[Math.min(this.#attempt, waits.length - 1)]!;
    this.#attempt += 1;
    this.#retryTimer = setTimeout(() => { this.#retryTimer = null; void this.#run('retry'); }, wait);
  }
}
