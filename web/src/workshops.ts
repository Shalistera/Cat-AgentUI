import type { LucideIcon } from 'lucide-react';
import { Image as ImageIcon, Languages, Presentation, ScanText } from 'lucide-react';

/** The sidebar's icon row. Order here is the default pin order. */
export interface Workshop { id: string; to: string; label: string; short: string; Icon: LucideIcon }

export const WORKSHOPS: Workshop[] = [
  { id: 'images', to: '/images', label: '绘图工坊', short: '绘图', Icon: ImageIcon },
  { id: 'ocr', to: '/ocr', label: 'OCR 工坊', short: 'OCR', Icon: ScanText },
  { id: 'ppt', to: '/ppt', label: 'PPT 工坊', short: 'PPT', Icon: Presentation },
  { id: 'translate', to: '/translate', label: '翻译工坊', short: '翻译', Icon: Languages },
];

/** Pinned workshops in the user's order; unknown ids (removed workshops) drop out. */
export function pinnedWorkshops(pins: string[] | null | undefined): Workshop[] {
  if (pins == null) return WORKSHOPS;
  return pins.map((id) => WORKSHOPS.find((w) => w.id === id)).filter((w): w is Workshop => !!w);
}
