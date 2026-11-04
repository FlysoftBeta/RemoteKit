/** Soft keyboard policy for the current remote editor, independent of layout epochs. */
export class KeyboardVisibility {
  private owner?: string;
  private manual = false;
  private dismissed = false;
  private attempted = false;

  sync(owner: string | undefined, manual: boolean) {
    if (owner === this.owner && manual === this.manual) return;
    this.owner = owner;
    this.manual = manual;
    this.dismissed = false;
    this.attempted = false;
  }

  get autoAllowed() { return !!this.owner && !this.manual && !this.dismissed; }
  takeAutoAttempt() {
    if (!this.autoAllowed || this.attempted) return false;
    this.attempted = true;
    return true;
  }

  hide() { this.dismissed = true; }
}
