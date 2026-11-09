/// <reference lib="es2022.intl" />
import type { SelectionAction } from '../rtc/protocol';

export interface Point {
  x: number;
  y: number;
}

export interface SelectionHandle extends Point {
  lineHeight: number;
  visible: boolean;
}

export type HandleKind = 'start' | 'end' | 'insertion';
export interface SelectionHandles {
  start?: SelectionHandle;
  end?: SelectionHandle;
  insertion?: SelectionHandle;
}

export interface SelectionTarget {
  handles(): SelectionHandles;
  anchor(): { left: number; top: number; width: number; height: number };
  commands(): SelectionAction[];
  run(command: SelectionAction): void | Promise<void>;
  dragHandle(which: HandleKind, point: Point): void;
  collapse(): void;
  alive(): boolean;
}

export interface SelectionClipboard {
  read(): string;
  write(text: string): Promise<void>;
}

const words = new Intl.Segmenter(undefined, { granularity: 'word' });

export function wordAt(text: string, offset: number): [number, number] {
  const position = Math.max(0, Math.min(offset, text.length));
  let previous: Intl.SegmentData | undefined;
  for (const segment of words.segment(text)) {
    const end = segment.index + segment.segment.length;
    if (position < end) {
      if (!segment.isWordLike && previous?.isWordLike && position === segment.index)
        return [previous.index, segment.index];
      return [segment.index, end];
    }
    previous = segment;
  }
  return previous ? [previous.index, text.length] : [0, 0];
}
