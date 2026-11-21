export type KeyboardOwner = { kind: 'remote'; viewId?: string } | { kind: 'shell' } | { kind: 'none' };

const SHELL_EDITABLE =
  'textarea:not([readonly]):not([disabled]), input:not([readonly]):not([disabled]):is(:not([type]), [type=text], [type=search], [type=email], [type=password], [type=url], [type=tel], [type=number]), [contenteditable=true]';

export function isRemoteEditor(element: Element | null): element is HTMLTextAreaElement {
  return element?.tagName === 'TEXTAREA' && element.classList.contains('remote-input');
}

export function isShellEditable(element: Element | null): element is HTMLElement {
  return !!element && !isRemoteEditor(element) && element.matches(SHELL_EDITABLE);
}

/** Who the on-screen keyboard belongs to: the focused editable that wants a soft keyboard. */
export function keyboardOwner(active: Element | null): KeyboardOwner {
  if (isRemoteEditor(active))
    return active.inputMode === 'none'
      ? { kind: 'none' }
      : { kind: 'remote', viewId: active.closest<HTMLElement>('.remote-viewport')?.dataset.viewId };
  if (isShellEditable(active))
    return (active as HTMLElement).inputMode === 'none' ? { kind: 'none' } : { kind: 'shell' };
  return { kind: 'none' };
}

/** A shell keyboard only covers shell UI; remote windows keep their stable geometry. */
export function keyboardAssignment(owner: KeyboardOwner, occludedBottom: number, fallbackViewId: string) {
  if (owner.kind === 'shell') return { viewId: '', remoteBottom: 0, shellBottom: occludedBottom };
  return {
    viewId: owner.kind === 'remote' ? (owner.viewId ?? fallbackViewId) : fallbackViewId,
    remoteBottom: occludedBottom,
    shellBottom: 0,
  };
}
