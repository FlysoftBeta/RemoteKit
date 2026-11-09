import type { SelectionAction } from '../rtc/protocol';
import { deviceClipboard } from '../clipboard/device-clipboard';
import { wordAt, type HandleKind, type Point, type SelectionClipboard, type SelectionTarget } from './target';

export type TextInput = HTMLInputElement | HTMLTextAreaElement;

export function isTextInput(node: Element): node is TextInput {
  return (
    (node instanceof HTMLTextAreaElement || node instanceof HTMLInputElement) &&
    !node.classList.contains('remote-input') &&
    !node.disabled &&
    node.selectionStart !== null
  );
}

// The mirror uses the input's layout size, then projects its caret through the
// shell transform. Scroll offsets remain in the input's unscaled coordinates.
export function measureInput(input: TextInput, visit: (caret: (offset: number) => DOMRect) => void) {
  const mirror = document.createElement('div');
  const style = getComputedStyle(input);
  for (const property of Array.from(style))
    mirror.style.setProperty(property, style.getPropertyValue(property));
  Object.assign(mirror.style, {
    position: 'fixed',
    left: '0',
    top: '0',
    margin: '0',
    transform: 'none',
    width: `${input.offsetWidth}px`,
    height: 'auto',
    minHeight: `${input.offsetHeight}px`,
    visibility: 'hidden',
    pointerEvents: 'none',
    overflow: 'visible',
    whiteSpace: input instanceof HTMLTextAreaElement ? 'pre-wrap' : 'pre',
    overflowWrap: 'break-word',
  });
  const text = document.createTextNode(input.value + '\u200b');
  mirror.append(text);
  document.documentElement.append(mirror);
  const origin = input.getBoundingClientRect();
  const bounds = mirror.getBoundingClientRect();
  const scaleX = origin.width / input.offsetWidth;
  const scaleY = origin.height / input.offsetHeight;
  const range = document.createRange();
  try {
    visit((offset) => {
      const index = Math.max(0, Math.min(offset, input.value.length));
      range.setStart(text, index);
      range.setEnd(text, index + 1);
      const rect = range.getBoundingClientRect();
      return new DOMRect(
        origin.left + (rect.left - bounds.left - input.scrollLeft) * scaleX,
        origin.top + (rect.top - bounds.top - input.scrollTop) * scaleY,
        0,
        rect.height * scaleY,
      );
    });
  } finally {
    mirror.remove();
  }
}

export function inputOffsetAt(input: TextInput, point: Point): number {
  let closest = 0;
  let distance = Infinity;
  measureInput(input, (caret) => {
    for (let offset = 0; offset <= input.value.length; offset++) {
      const rect = caret(offset);
      const dy = Math.max(rect.top - point.y, point.y - rect.bottom, 0);
      const next = dy * dy * 100 + (rect.left - point.x) ** 2;
      if (next < distance) {
        closest = offset;
        distance = next;
      }
      if (input.value.codePointAt(offset)! > 0xffff) offset++;
    }
  });
  return closest;
}

export class LocalInputTarget implements SelectionTarget {
  constructor(
    readonly input: TextInput,
    private readonly clipboard: SelectionClipboard,
    private readonly pointerType: 'touch' | 'mouse' = 'touch',
  ) {}

  selectWord(point: Point) {
    const [start, end] = wordAt(this.input.value, inputOffsetAt(this.input, point));
    this.input.focus({ preventScroll: true });
    this.input.setSelectionRange(start, end);
  }

  private rects() {
    let start!: DOMRect;
    let end!: DOMRect;
    measureInput(this.input, (caret) => {
      start = caret(this.input.selectionStart ?? 0);
      end = caret(this.input.selectionEnd ?? 0);
    });
    return { start, end };
  }

  handles() {
    if (this.pointerType === 'mouse') return {};
    const { start, end } = this.rects();
    const bounds = this.input.getBoundingClientRect();
    const handle = (rect: DOMRect) => ({
      x: rect.left,
      y: rect.bottom,
      lineHeight: rect.height,
      visible:
        rect.left >= bounds.left &&
        rect.left <= bounds.right &&
        rect.bottom >= bounds.top &&
        rect.top <= bounds.bottom,
    });
    return this.input.selectionStart === this.input.selectionEnd
      ? { insertion: handle(start) }
      : { start: handle(start), end: handle(end) };
  }

  anchor() {
    const { start, end } = this.rects();
    return {
      left: Math.min(start.left, end.left),
      top: Math.min(start.top, end.top),
      width: Math.abs(end.left - start.left),
      height: Math.max(start.bottom, end.bottom) - Math.min(start.top, end.top),
    };
  }

  commands(): SelectionAction[] {
    const selected = this.input.selectionStart !== this.input.selectionEnd && this.input.type !== 'password';
    return [
      ...(selected && !this.input.readOnly ? ['cut' as const] : []),
      ...(selected ? ['copy' as const] : []),
      ...(!this.input.readOnly ? ['paste' as const] : []),
      ...(this.input.value ? ['selectAll' as const] : []),
    ];
  }

  async run(command: SelectionAction) {
    const start = this.input.selectionStart ?? 0;
    const end = this.input.selectionEnd ?? start;
    const original = this.input.value;
    if (command === 'selectAll') {
      this.input.setSelectionRange(0, this.input.value.length);
      return;
    }
    if (command === 'copy' || command === 'cut') {
      if (this.input.type === 'password') return;
      await this.clipboard.write(original.slice(start, end));
      if (
        command === 'copy' ||
        !this.alive() ||
        this.input.value !== original ||
        this.input.selectionStart !== start ||
        this.input.selectionEnd !== end
      )
        return;
    }
    if (this.input.readOnly || (command !== 'paste' && command !== 'cut')) return;
    if (command === 'paste') {
      await deviceClipboard.readForPaste(false);
      if (
        !this.alive() ||
        this.input.readOnly ||
        this.input.value !== original ||
        this.input.selectionStart !== start ||
        this.input.selectionEnd !== end
      )
        return;
    }
    const text = command === 'paste' ? this.clipboard.read() : '';
    const before = new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: command === 'paste' ? 'insertFromPaste' : 'deleteByCut',
      data: text,
    });
    if (!this.input.dispatchEvent(before)) return;
    // Use the native setter so React's controlled-input tracker sees the edit.
    const value = this.input.value.slice(0, start) + text + this.input.value.slice(end);
    const prototype =
      this.input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(this.input, value);
    this.input.setSelectionRange(start + text.length, start + text.length);
    this.input.dispatchEvent(
      new InputEvent('input', { bubbles: true, inputType: before.inputType, data: text }),
    );
  }

  dragHandle(which: HandleKind, point: Point) {
    const offset = inputOffsetAt(this.input, point);
    const start = this.input.selectionStart ?? 0;
    const end = this.input.selectionEnd ?? start;
    if (which === 'insertion') this.input.setSelectionRange(offset, offset);
    else if (which === 'start') this.input.setSelectionRange(Math.min(offset, end), end);
    else this.input.setSelectionRange(start, Math.max(start, offset));
  }

  collapse() {
    const end = this.input.selectionEnd ?? 0;
    this.input.setSelectionRange(end, end);
  }

  alive() {
    return this.input.isConnected && document.activeElement === this.input;
  }
}
