/** Remove only an exact, substantial repeated suffix at the start of a
 * continuation. Keep a small prefix until the overlap is unambiguous. */
export class ContinuationText {
  private readonly suffixes: string[];
  private pending = '';
  private settled = false;
  constructor(original: string) {
    const tail = original.slice(-4096);
    const min = Math.min(64, tail.length);
    this.suffixes = tail.length < 12 ? [] : Array.from({ length: tail.length - min + 1 }, (_, i) => tail.slice(i));
  }
  push(text: string): string {
    if (this.settled) return text;
    this.pending += text;
    if (this.suffixes.some((suffix) => suffix.startsWith(this.pending))) return '';
    return this.flush();
  }
  flush(): string {
    this.settled = true;
    const overlap = this.suffixes.find((suffix) => this.pending.startsWith(suffix));
    const text = this.pending.slice(overlap?.length ?? 0);
    this.pending = '';
    return text;
  }
}
