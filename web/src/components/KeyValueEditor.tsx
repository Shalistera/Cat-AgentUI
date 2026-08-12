import { Plus, X } from 'lucide-react';
import { Button, Input } from './ui';

// Shared by the provider modal (自定义请求头) and the MCP server modal (环境变量) —
// one editor, one visual weight for "添加一行" everywhere.

export interface KVPair { k: string; v: string }

export function objectToPairs(obj: Record<string, string> | null | undefined): KVPair[] {
  return Object.entries(obj ?? {}).map(([k, v]) => ({ k, v }));
}

export function pairsToObject(pairs: KVPair[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of pairs) {
    const k = p.k.trim();
    if (k) out[k] = p.v;
  }
  return out;
}

export function KeyValueEditor({ pairs, onChange, keyPlaceholder = 'Key', valuePlaceholder = 'Value' }: {
  pairs: KVPair[]; onChange(pairs: KVPair[]): void; keyPlaceholder?: string; valuePlaceholder?: string;
}) {
  return (
    <div className="space-y-2">
      {pairs.map((p, i) => (
        <div key={i} className="flex items-center gap-2">
          <Input
            placeholder={keyPlaceholder} value={p.k}
            onChange={(e) => onChange(pairs.map((x, j) => (j === i ? { ...x, k: e.target.value } : x)))}
          />
          <Input
            placeholder={valuePlaceholder} value={p.v}
            onChange={(e) => onChange(pairs.map((x, j) => (j === i ? { ...x, v: e.target.value } : x)))}
          />
          <Button variant="ghost" size="icon" title="删除此行" className="shrink-0"
            onClick={() => onChange(pairs.filter((_, j) => j !== i))}>
            <X size={14} />
          </Button>
        </div>
      ))}
      <Button variant="outline" size="sm" onClick={() => onChange([...pairs, { k: '', v: '' }])}>
        <Plus size={13} />添加一行
      </Button>
    </div>
  );
}
