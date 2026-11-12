import type { FloatingActions } from '../app/floating-actions';

export class ShellKeyboard {
  private owner?: HTMLElement;
  private inputMode = '';
  private hidden = false;
  private disposed = false;
  constructor(
    private readonly document: Document,
    private readonly actions: FloatingActions,
  ) {
    document.addEventListener('focusin', this.observe);
    document.addEventListener('focusout', this.blur);
    this.observe();
  }
  private blur = () => queueMicrotask(this.observe);
  private observe = () => {
    if (this.disposed) return;
    const active = this.document.activeElement as HTMLElement | null;
    const editable = active?.matches(
      'textarea:not([readonly]):not([disabled]), input:not([readonly]):not([disabled]):is(:not([type]), [type=text], [type=search], [type=email], [type=password], [type=url], [type=tel], [type=number]), [contenteditable=true]',
    );
    const owner = editable && !active!.classList.contains('remote-input') ? active! : undefined;
    if (this.owner !== owner) {
      if (this.owner && this.hidden) this.owner.inputMode = this.inputMode;
      this.owner = owner;
      this.hidden = false;
    }
    this.actions.set(
      'keyboard:shell',
      owner
        ? {
            id: 'keyboard:shell',
            order: 10,
            anchor: 'bottom-right',
            label: this.hidden ? '显示键盘' : '隐藏键盘',
            icon: this.hidden ? 'keyboard' : 'keyboard-hide',
            run: this.toggle,
          }
        : undefined,
    );
  };
  private toggle = () => {
    const owner = this.owner;
    if (!owner) return;
    if (!this.hidden) this.inputMode = owner.inputMode;
    this.hidden = !this.hidden;
    owner.inputMode = this.hidden ? 'none' : this.inputMode;
    owner.blur();
    owner.focus({ preventScroll: true });
    this.observe();
  };
  dispose() {
    this.disposed = true;
    this.document.removeEventListener('focusin', this.observe);
    this.document.removeEventListener('focusout', this.blur);
    if (this.owner && this.hidden) this.owner.inputMode = this.inputMode;
    this.actions.set('keyboard:shell', undefined);
  }
}
