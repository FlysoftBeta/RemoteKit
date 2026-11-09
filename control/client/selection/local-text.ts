import type { SelectionAction } from '../rtc/protocol';
import { wordAt, type HandleKind, type Point, type SelectionClipboard, type SelectionTarget } from './target';
import { applySelection } from './selection-session';

export function textCaretAt(content: HTMLElement, point: Point): Range | undefined {
  const root = content.getRootNode();
  const shadow = root instanceof ShadowRoot ? root : content.shadowRoot;
  const position = document.caretPositionFromPoint?.(point.x, point.y, {
    shadowRoots: shadow ? [shadow] : [],
  });
  let range: Range | null | undefined;
  if (position) {
    range = document.createRange();
    range.setStart(position.offsetNode, position.offset);
    range.collapse(true);
  } else {
    const scope = shadow as (ShadowRoot & { caretRangeFromPoint?: Document['caretRangeFromPoint'] }) | null;
    range =
      scope?.caretRangeFromPoint?.(point.x, point.y) ?? document.caretRangeFromPoint?.(point.x, point.y);
  }
  if (range && content.contains(range.startContainer)) return range;
  // Chrome 89 does not expose shadow-aware caret hit testing. Measure text
  // ranges inside the page rather than accepting the retargeted host caret.
  let best: Range | undefined;
  let distance = Infinity;
  const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    if (node.parentElement?.closest('style,script,[aria-hidden="true"]')) continue;
    const text = node.textContent ?? '';
    for (let index = 0; index < text.length; index++) {
      const candidate = document.createRange();
      candidate.setStart(node, index);
      candidate.setEnd(node, Math.min(text.length, index + (text.codePointAt(index)! > 0xffff ? 2 : 1)));
      const rect = candidate.getBoundingClientRect();
      if (!rect.height) continue;
      const dy = Math.max(rect.top - point.y, point.y - rect.bottom, 0);
      const dx = Math.max(rect.left - point.x, point.x - rect.right, 0);
      const next = dy * dy * 100 + dx * dx;
      if (next < distance) {
        distance = next;
        best = candidate;
        if (point.x > rect.left + rect.width / 2) best.collapse(false);
        else best.collapse(true);
      }
      if (text.codePointAt(index)! > 0xffff) index++;
    }
  }
  return best;
}

export class LocalTextTarget implements SelectionTarget {
  private range: Range | undefined;
  constructor(
    readonly content: HTMLElement,
    private readonly clipboard: SelectionClipboard,
    private readonly pointerType: 'touch' | 'mouse' = 'touch',
  ) {}

  private publish(range: Range) {
    this.range = range;
    const root = this.content.getRootNode() as
      Document | (ShadowRoot & { getSelection?: () => Selection | null });
    const selection = root.getSelection?.() ?? document.getSelection();
    applySelection(() => {
      selection?.removeAllRanges();
      selection?.addRange(range);
    });
  }

  selectWord(point: Point) {
    const range = textCaretAt(this.content, point);
    if (!range) return false;
    const focused = document.activeElement;
    if (focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement) focused.blur();
    if (range.startContainer.nodeType === Node.TEXT_NODE) {
      const [start, end] = wordAt(range.startContainer.textContent ?? '', range.startOffset);
      range.setStart(range.startContainer, start);
      range.setEnd(range.startContainer, end);
    }
    this.publish(range);
    return !range.collapsed;
  }

  adoptSelection() {
    const root = this.content.getRootNode() as
      Document | (ShadowRoot & { getSelection?: () => Selection | null });
    const selection = root.getSelection?.() ?? document.getSelection();
    if (
      selection?.rangeCount &&
      this.content.contains(selection.anchorNode) &&
      this.content.contains(selection.focusNode)
    )
      this.range = selection.getRangeAt(0).cloneRange();
  }

  handles() {
    if (this.pointerType === 'mouse' || !this.range || this.range.collapsed) return {};
    const edge = (start: boolean) => {
      const range = this.range!.cloneRange();
      range.collapse(start);
      const rect = range.getBoundingClientRect();
      return { x: rect.left, y: rect.bottom, lineHeight: rect.height, visible: rect.height > 0 };
    };
    return { start: edge(true), end: edge(false) };
  }

  anchor() {
    return this.range?.getBoundingClientRect() ?? this.content.getBoundingClientRect();
  }

  commands(): SelectionAction[] {
    return this.range?.collapsed === false ? ['copy', 'selectAll'] : ['selectAll'];
  }

  async run(command: SelectionAction) {
    if (command === 'copy') await this.clipboard.write(this.range?.toString() ?? '');
    if (command === 'selectAll') {
      const range = document.createRange();
      range.selectNodeContents(this.content);
      this.publish(range);
    }
  }

  dragHandle(which: HandleKind, point: Point) {
    const caret = textCaretAt(this.content, point);
    if (!caret || !this.range || which === 'insertion') return;
    const range = this.range.cloneRange();
    if (which === 'start' && range.comparePoint(caret.startContainer, caret.startOffset) <= 0)
      range.setStart(caret.startContainer, caret.startOffset);
    else if (which === 'end' && range.comparePoint(caret.startContainer, caret.startOffset) >= 0)
      range.setEnd(caret.startContainer, caret.startOffset);
    this.publish(range);
  }

  collapse() {
    this.range?.collapse(false);
    if (this.range) this.publish(this.range);
  }

  alive() {
    return this.content.isConnected && !!this.range?.startContainer.isConnected;
  }
}
