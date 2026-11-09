import assert from 'node:assert/strict';
import test from 'node:test';
import { isDocument } from '../server/learning/document-type';

test('study pre-render accepts Endpoint document formats and rejects media and archives', () => {
  for (const extension of [
    'pdf',
    'rtf',
    'doc',
    'dot',
    'wps',
    'docx',
    'docm',
    'dotx',
    'odt',
    'ppt',
    'pps',
    'pot',
    'dps',
    'pptx',
    'ppsx',
    'potx',
    'odp',
    'xls',
    'et',
    'xlsx',
    'xlsm',
    'ods',
    'txt',
    'csv',
  ])
    assert.equal(isDocument('lesson.' + extension.toUpperCase(), Buffer.from('text')), true, extension);
  for (const extension of ['png', 'jpg', 'gif', 'mp3', 'mp4', 'zip', 'rar', '7z'])
    assert.equal(isDocument('lesson.' + extension, Buffer.from('text')), false, extension);
  for (const magic of ['\x89PNG', '\xff\xd8\xff', 'GIF89a', 'ID3', 'RIFF0000WAVE', '0000ftyp', 'MZ'])
    assert.equal(isDocument('disguised.docx', Buffer.from(magic, 'latin1')), false, magic);
  assert.equal(isDocument('plain.txt', Buffer.from([0, 1, 2])), false);
  assert.equal(isDocument('unicode.txt', Buffer.from([255, 254, 65, 0])), true);
  assert.equal(isDocument('unknown', Buffer.from('%PDF-1.7')), true);
  assert.equal(isDocument('unknown', Buffer.from('{\\rtf1')), true);
});
