export type FileKind =
  'image' | 'pdf' | 'document' | 'sheet' | 'slides' | 'archive' | 'audio' | 'video' | 'text' | 'other';

const EXTENSIONS: Record<string, FileKind> = {
  pdf: 'pdf',
  doc: 'document',
  docx: 'document',
  wps: 'document',
  rtf: 'document',
  odt: 'document',
  pages: 'document',
  xls: 'sheet',
  xlsx: 'sheet',
  et: 'sheet',
  csv: 'sheet',
  ods: 'sheet',
  numbers: 'sheet',
  ppt: 'slides',
  pptx: 'slides',
  dps: 'slides',
  odp: 'slides',
  key: 'slides',
  zip: 'archive',
  rar: 'archive',
  '7z': 'archive',
  gz: 'archive',
  tgz: 'archive',
  tar: 'archive',
  zst: 'archive',
  txt: 'text',
  md: 'text',
  json: 'text',
  xml: 'text',
  log: 'text',
  mp3: 'audio',
  m4a: 'audio',
  wav: 'audio',
  ogg: 'audio',
  flac: 'audio',
  mp4: 'video',
  webm: 'video',
  mov: 'video',
  m4v: 'video',
  jpg: 'image',
  jpeg: 'image',
  png: 'image',
  gif: 'image',
  webp: 'image',
};

export function fileExtension(name: string) {
  const dot = name.lastIndexOf('.');
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toLowerCase() : '';
}

export function fileKind(type: string, name: string): FileKind {
  const mime = type.toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  if (mime === 'application/pdf') return 'pdf';
  const byExtension = EXTENSIONS[fileExtension(name)];
  if (byExtension) return byExtension;
  if (mime.startsWith('text/')) return 'text';
  return 'other';
}

export const isImageFile = (item: { type: string }) => item.type.toLowerCase().startsWith('image/');

const UNITS = ['KB', 'MB', 'GB'];
export function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${UNITS[unit]}`;
}

const dayFormat = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric' });
const yearFormat = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
const timeFormat = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });

const startOfDay = (time: number) => {
  const date = new Date(time);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
};

// Section label for a day: 今天 / 昨天 / M月D日 / YYYY年M月D日.
export function dayLabel(time: number, now = Date.now()) {
  const days = Math.round((startOfDay(now) - startOfDay(time)) / 86400000);
  if (days === 0) return '今天';
  if (days === 1) return '昨天';
  return new Date(time).getFullYear() === new Date(now).getFullYear()
    ? dayFormat.format(time)
    : yearFormat.format(time);
}

export const formatTime = (time: number) => timeFormat.format(time);
