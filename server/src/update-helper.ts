// Deployments whose checkout belongs to root while the panel runs as its own
// unprivileged user: the panel can't touch the code, so updates go through
// deploy/cat-agentui-update instead (set up by deploy/update-helper-setup.sh).
// The panel drops a one-line request into the helper's inbox, the path unit
// cat-agentui-update@INSTANCE.path starts the helper as root, and the helper
// answers through a status file and a log beside the inbox.
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

const HELPER_ROOT = process.env.UPDATE_HELPER_DIR || '/var/lib/cat-agentui-update';
/** Request/status format spoken with the helper (its PROTOCOL). */
const PROTOCOL = 1;

export interface Helper {
  /** Name under /etc/cat-agentui/instances.d */
  instance: string;
  dir: string;
  /** The systemd unit it restarts. */
  service: string | null;
}

export interface HelperStatus {
  /** The request this describes. */
  id: string;
  action: string;
  state: 'running' | 'built' | 'restarting' | 'done' | 'failed' | 'cancelled';
  step: string;
  from: string;
  to: string;
  deps: boolean;
  /** Short failure code (fetch, dirty, build, timeout…) and the helper's message. */
  error: string;
  detail: string;
  rollbackFailed: boolean;
}

function readFields(file: string): Map<string, string> | null {
  let text: string;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const fields = new Map<string, string>();
  for (const line of text.split('\n')) {
    const i = line.indexOf('=');
    if (i > 0) fields.set(line.slice(0, i), line.slice(i + 1));
  }
  return fields;
}

function realDir(dir: string): string | null {
  try { return fs.realpathSync(dir); } catch { return null; }
}

/** The helper set up for the checkout at `repo`; with several, the one restarting `unit`. */
export function findHelper(repo: string, unit: string | null): Helper | null {
  const real = realDir(repo);
  let names: string[];
  try { names = fs.readdirSync(HELPER_ROOT).sort(); } catch { return null; }
  if (!real) return null;
  const found: Helper[] = [];
  for (const instance of names) {
    const dir = path.join(HELPER_ROOT, instance);
    const info = readFields(path.join(dir, 'info'));
    const infoRepo = info?.get('repo');
    if (!infoRepo || realDir(infoRepo) !== real) continue;
    found.push({ instance, dir, service: info!.get('service') || null });
  }
  return found.find((h) => h.service === unit) ?? found[0] ?? null;
}

export function readStatus(h: Helper): HelperStatus | null {
  const f = readFields(path.join(h.dir, 'status'));
  if (!f?.get('id')) return null;
  return {
    id: f.get('id')!,
    action: f.get('action') ?? '',
    state: (f.get('state') ?? 'running') as HelperStatus['state'],
    step: f.get('step') ?? '',
    from: f.get('from') ?? '',
    to: f.get('to') ?? '',
    deps: f.get('deps') === '1',
    error: f.get('error') ?? '',
    detail: f.get('detail') ?? '',
    rollbackFailed: f.get('rollback_failed') === '1',
  };
}

/** Write an inbox file in one step, so the helper never reads half of it. */
function drop(h: Helper, name: string, line: string): void {
  const inbox = path.join(h.dir, 'inbox');
  const tmp = path.join(inbox, `.${name}-${process.pid}`);
  fs.writeFileSync(tmp, `${line}\n`);
  fs.renameSync(tmp, path.join(inbox, name));
}

/** `check` fetches the remote; `update` moves to `target`, then waits for go or abort. */
export function sendRequest(h: Helper, action: 'check' | 'update', id: string, target?: string): void {
  drop(h, 'request', [PROTOCOL, action, id, ...(target ? [target] : [])].join(' '));
}

/** Take back a request nobody picked up, so it doesn't run some time later. */
export function withdrawRequest(h: Helper): void {
  try { fs.rmSync(path.join(h.dir, 'inbox', 'request'), { force: true }); } catch { /* gone */ }
}

/** A prepared update: swap it in and restart (go), or roll it back (abort). */
export function sendVerdict(h: Helper, verdict: 'go' | 'abort', id: string): void {
  drop(h, verdict, id);
}

/** The helper's log, read on as it grows; a new request starts it afresh. */
export class HelperLog {
  private offset = 0;
  private rest = '';
  private decoder = new StringDecoder('utf8');

  constructor(private readonly file: string) {}

  /** Complete lines written since the last call; `all` also returns a trailing partial one. */
  read(all = false): string[] {
    let text = '';
    let fd: number | null = null;
    try {
      fd = fs.openSync(this.file, 'r');
      const size = fs.fstatSync(fd).size;
      if (size < this.offset) {
        this.offset = 0;
        this.rest = '';
        this.decoder = new StringDecoder('utf8');
      }
      while (this.offset < size) {
        const buf = Buffer.alloc(Math.min(size - this.offset, 256 * 1024));
        const n = fs.readSync(fd, buf, 0, buf.length, this.offset);
        if (n <= 0) break;
        this.offset += n;
        text += this.decoder.write(buf.subarray(0, n));
      }
    } catch {
      // not written yet
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
    const lines = (this.rest + text).split(/\r?\n|\r/);
    this.rest = lines.pop()!;
    if (all && this.rest) {
      lines.push(this.rest);
      this.rest = '';
    }
    return lines;
  }
}

export function helperLog(h: Helper): HelperLog {
  return new HelperLog(path.join(h.dir, 'log'));
}
