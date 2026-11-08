/** One small atlas crop per window, captured only when leaving a space. */
export class SpaceSnapshots {
  private readonly images = new Map<string, string>();
  get(windowId: string) {
    return this.images.get(windowId);
  }
  capture(root: HTMLElement, windowIds: string[]) {
    for (const windowId of windowIds) {
      const frame = [...root.querySelectorAll<HTMLElement>('[data-window-id]')].find(
        (node) => node.dataset.windowId === windowId,
      );
      const video = frame?.querySelector<HTMLVideoElement>('.remote-video-plane video');
      const clip = video?.parentElement;
      if (!video || !clip || video.readyState < 2 || !video.videoWidth) continue;
      const videoWidth = parseFloat(video.style.width);
      const videoHeight = parseFloat(video.style.height);
      if (!(videoWidth > 0 && videoHeight > 0)) continue;
      const width = parseFloat(clip.style.width),
        height = parseFloat(clip.style.height);
      if (!(width > 0 && height > 0)) continue;
      const canvas = document.createElement('canvas');
      const scale = Math.min(1, 320 / width, 240 / height);
      canvas.width = Math.max(1, Math.round(width * scale));
      canvas.height = Math.max(1, Math.round(height * scale));
      const scaleX = video.videoWidth / videoWidth;
      const scaleY = video.videoHeight / videoHeight;
      const context = canvas.getContext('2d');
      if (!context) continue;
      context.drawImage(
        video,
        -parseFloat(video.style.left || '0') * scaleX,
        -parseFloat(video.style.top || '0') * scaleY,
        width * scaleX,
        height * scaleY,
        0,
        0,
        canvas.width,
        canvas.height,
      );
      this.images.set(windowId, canvas.toDataURL('image/jpeg', 0.7));
    }
  }
  retain(windowIds: string[]) {
    for (const id of this.images.keys()) if (!windowIds.includes(id)) this.images.delete(id);
  }
}
