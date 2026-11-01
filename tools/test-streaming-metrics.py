"""Reject incomplete/corrupted uploads and preserve reports across chunk boundaries."""
import copy
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from streaming_metrics import load_metrics


class UploadTests(unittest.TestCase):
    def setUp(self):
        self.report = {'kind': 'streaming-benchmark', 'config': {'id': 'test'},
                       'tenantIndex': 0, 'raw': ['中文', '😀', [1, 2, 3]]}
        text = json.dumps(self.report, ensure_ascii=False)
        # Deliberately split between the two JS UTF-16 units of the emoji.
        units = text.encode('utf-16-le')
        split = units.index('😀'.encode('utf-16-le')) + 2
        parts = [units[:split].decode('utf-16-le', errors='surrogatepass'),
                 units[split:].decode('utf-16-le', errors='surrogatepass')]
        identity = {'runId': 'test', 'tenantIndex': 0, 'chunks': 2}
        self.records = [{'metrics': {'kind': 'benchmark-report-chunk', **identity,
                                     'part': i, 'text': value}} for i, value in enumerate(parts)]
        self.records.append({'metrics': {'kind': 'benchmark-report-manifest', **identity,
                                         'encoding': 'utf-8', 'characters': len(units) // 2,
                                         'bytes': len(text.encode()), 'sha256': hashlib.sha256(text.encode()).hexdigest()}})

    def load(self, records):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'metrics.jsonl'
            path.write_text(''.join(json.dumps(record) + '\n' for record in records), encoding='utf-8')
            return load_metrics(path)

    def test_complete_unicode_report(self):
        self.assertEqual(self.load(self.records)[-1]['metrics'], self.report)

    def test_legacy_report(self):
        self.assertEqual(self.load([{'metrics': self.report}]), [{'metrics': self.report}])

    def test_missing_chunk_or_manifest(self):
        for records in (self.records[1:], self.records[:-1]):
            with self.assertRaises(ValueError):
                self.load(records)

    def test_corrupt_payload(self):
        records = copy.deepcopy(self.records)
        records[0]['metrics']['text'] = records[0]['metrics']['text'].replace('test', 'tEst')
        with self.assertRaisesRegex(ValueError, 'SHA-256'):
            self.load(records)

    def test_duplicate_chunk(self):
        with self.assertRaisesRegex(ValueError, 'Duplicate'):
            self.load(self.records + [self.records[0]])


if __name__ == '__main__':
    unittest.main()
