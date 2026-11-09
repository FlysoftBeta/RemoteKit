// Keep the named-file classification aligned with Endpoint DetectDocument.
export function isDocument(name: string, prefix: Buffer) {
  const starts = (value: string) =>
    prefix.subarray(0, Buffer.byteLength(value, 'latin1')).equals(Buffer.from(value, 'latin1'));
  if (starts('%PDF-') || starts('{\\rtf')) return true;
  const unicode = starts('\xff\xfe') || starts('\xfe\xff');
  if (!unicode) {
    if (
      [
        '\x89PNG',
        '\xff\xd8\xff',
        'GIF87a',
        'GIF89a',
        'BM',
        'ID3',
        'fLaC',
        'OggS',
        '\x1a\x45\xdf\xa3',
        'MZ',
        'II*\0',
        'MM\0*',
      ].some(starts)
    )
      return false;
    if (
      (prefix.length >= 12 && starts('RIFF')) ||
      (prefix.length >= 8 && prefix.subarray(4, 8).toString('latin1') === 'ftyp') ||
      (prefix.length >= 2 && prefix[0] === 255 && (prefix[1] & 224) === 224)
    )
      return false;
  }
  const dot = name.lastIndexOf('.');
  const extension = dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
  if (extension === 'txt' || extension === 'csv')
    return unicode || prefix.every((byte) => byte >= 32 || byte === 9 || byte === 10 || byte === 13);
  return /^(pdf|rtf|doc|dot|wps|docx|docm|dotx|odt|ppt|pps|pot|dps|pptx|ppsx|potx|odp|xls|et|xlsx|xlsm|ods)$/.test(
    extension,
  );
}
