// A tiny cBPF seccomp filter for the 沙盒, handed to bwrap via --seccomp.
//
// Why: the workspace is bind-mounted read-write into the sandbox, so a
// command could create a symlink there pointing at a host path and race the
// panel's "check, then read" into following it. Refusing symlink creation at
// the syscall level removes the object entirely; mknod (FIFOs that would hang
// a reader), mount/unshare/pivot_root (namespace games) go with it. Anything
// not listed is allowed — this is a denylist on top of bwrap's isolation, not
// a replacement for it.
//
// Per-architecture syscall numbers; an unknown arch gets no filter (the env
// check reports that) rather than a wrong one.
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';

// Not imported from env.ts: env.ts imports this module for the self-check,
// and a cycle would leave `sandboxDir` uninitialised at load time.
const sandboxDir = path.join(config.dataDir, 'sandbox');

const AUDIT_ARCH_X86_64 = 0xC000003E;
const AUDIT_ARCH_AARCH64 = 0xC00000B7;
const X32_SYSCALL_BIT = 0x40000000;

const DENY_BY_ARCH: Record<string, { audit: number; syscalls: Record<string, number> }> = {
  x64: {
    audit: AUDIT_ARCH_X86_64,
    syscalls: { symlink: 88, symlinkat: 266, mknod: 133, mknodat: 259, mount: 165, umount2: 166, pivot_root: 155, unshare: 272, setns: 308, move_mount: 429, open_tree: 428, fsmount: 432 },
  },
  arm64: {
    audit: AUDIT_ARCH_AARCH64,
    syscalls: { symlinkat: 36, mknodat: 33, mount: 40, umount2: 39, pivot_root: 41, unshare: 97, setns: 268, move_mount: 429, open_tree: 428, fsmount: 432 },
  },
};

// BPF opcodes / seccomp return values (linux/filter.h, linux/seccomp.h)
const BPF_LD_W_ABS = 0x20;
const BPF_JMP_JEQ_K = 0x15;
const BPF_JMP_JSET_K = 0x45;
const BPF_RET_K = 0x06;
const SECCOMP_RET_ALLOW = 0x7fff0000;
const SECCOMP_RET_KILL_PROCESS = 0x80000000;
const SECCOMP_RET_ERRNO = 0x00050000;
const EPERM = 1;
const OFF_NR = 0;
const OFF_ARCH = 4;

interface Insn { code: number; jt: number; jf: number; k: number }

function encode(prog: Insn[]): Buffer {
  const buf = Buffer.alloc(prog.length * 8);
  prog.forEach((i, idx) => {
    buf.writeUInt16LE(i.code, idx * 8);
    buf.writeUInt8(i.jt, idx * 8 + 2);
    buf.writeUInt8(i.jf, idx * 8 + 3);
    buf.writeUInt32LE(i.k >>> 0, idx * 8 + 4);
  });
  return buf;
}

export function deniedSyscallNames(): string[] | null {
  const t = DENY_BY_ARCH[process.arch];
  return t ? Object.keys(t.syscalls) : null;
}

/** Build the filter for the running architecture; null when unsupported. */
export function buildSeccompFilter(): Buffer | null {
  const t = DENY_BY_ARCH[process.arch];
  if (!t) return null;
  const nrs = Object.values(t.syscalls);
  // layout:
  //   0: ld arch
  //   1: jeq AUDIT → +1 else → KILL (foreign ABI)
  //   2: ld nr
  //   3: jset X32 bit → KILL (x86_64 only; harmless elsewhere)
  //   4..4+n-1: jeq nr_i → ERRNO
  //   4+n: ret ALLOW
  //   4+n+1: ret ERRNO(EPERM)
  //   4+n+2: ret KILL
  const n = nrs.length;
  const idxAllow = 4 + n;
  const idxErrno = idxAllow + 1;
  const idxKill = idxAllow + 2;
  const prog: Insn[] = [];
  prog.push({ code: BPF_LD_W_ABS, jt: 0, jf: 0, k: OFF_ARCH });
  prog.push({ code: BPF_JMP_JEQ_K, jt: 0, jf: idxKill - 2, k: t.audit });
  prog.push({ code: BPF_LD_W_ABS, jt: 0, jf: 0, k: OFF_NR });
  prog.push({ code: BPF_JMP_JSET_K, jt: idxKill - 4, jf: 0, k: X32_SYSCALL_BIT });
  nrs.forEach((nr, i) => {
    const at = 4 + i;
    prog.push({ code: BPF_JMP_JEQ_K, jt: idxErrno - at - 1, jf: 0, k: nr });
  });
  prog.push({ code: BPF_RET_K, jt: 0, jf: 0, k: SECCOMP_RET_ALLOW });
  prog.push({ code: BPF_RET_K, jt: 0, jf: 0, k: SECCOMP_RET_ERRNO | EPERM });
  prog.push({ code: BPF_RET_K, jt: 0, jf: 0, k: SECCOMP_RET_KILL_PROCESS });
  return encode(prog);
}

export const seccompFilterPath = path.join(sandboxDir, 'seccomp.bpf');

/** Write the filter next to the venv; returns its path, or null when the
    architecture has no table (the executor then runs without it). */
export function ensureSeccompFilter(): string | null {
  const buf = buildSeccompFilter();
  if (!buf) return null;
  fs.mkdirSync(sandboxDir, { recursive: true, mode: 0o700 });
  try {
    if (fs.existsSync(seccompFilterPath) && fs.readFileSync(seccompFilterPath).equals(buf)) return seccompFilterPath;
  } catch { /* rewrite */ }
  const tmp = `${seccompFilterPath}.tmp`;
  fs.writeFileSync(tmp, buf, { mode: 0o600 });
  fs.renameSync(tmp, seccompFilterPath);
  return seccompFilterPath;
}
