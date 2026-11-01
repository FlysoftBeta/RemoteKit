"""Load complete benchmark records, validating chunked post-measurement uploads."""
import hashlib
import json
from pathlib import Path


def load_metrics(path):
    records = [json.loads(line) for line in Path(path).read_text(encoding='utf-8-sig').splitlines()]
    chunks = {}
    manifests = {}
    for record in records:
        m = record.get('metrics', {})
        if m.get('kind') not in ('benchmark-report-chunk', 'benchmark-report-manifest'):
            continue
        key = (m['runId'], m['tenantIndex'])
        if m['kind'] == 'benchmark-report-manifest':
            if key in manifests:
                raise ValueError(f'Duplicate benchmark manifest: {key}')
            manifests[key] = record
        else:
            parts = chunks.setdefault(key, {})
            if m['part'] in parts:
                raise ValueError(f'Duplicate benchmark chunk: {key}/{m["part"]}')
            parts[m['part']] = m
    if set(chunks) != set(manifests):
        raise ValueError('Incomplete benchmark upload: missing chunks or final manifest')
    for key, record in manifests.items():
        manifest = record['metrics']
        parts = chunks[key]
        count = manifest['chunks']
        if manifest.get('encoding') != 'utf-8' or set(parts) != set(range(count)):
            raise ValueError(f'Invalid benchmark chunk range or encoding: {key}')
        if any(part['chunks'] != count for part in parts.values()):
            raise ValueError(f'Inconsistent benchmark chunk count: {key}')
        text = ''.join(parts[i]['text'] for i in range(count))
        # JS slices UTF-16 code units; a boundary may split a surrogate pair.
        text = text.encode('utf-16-le', errors='surrogatepass').decode('utf-16-le')
        encoded = text.encode('utf-8')
        if (len(text.encode('utf-16-le')) // 2 != manifest['characters'] or
                len(encoded) != manifest['bytes'] or
                hashlib.sha256(encoded).hexdigest() != manifest['sha256']):
            raise ValueError(f'Benchmark length or SHA-256 mismatch: {key}')
        report = json.loads(text)
        if (report.get('kind') != 'streaming-benchmark' or
                report['config']['id'] != key[0] or report['tenantIndex'] != key[1]):
            raise ValueError(f'Benchmark report identity mismatch: {key}')
        records.append({**record, 'metrics': report})
    return records


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('path', type=Path)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    records = load_metrics(args.path)
    args.output.write_text(''.join(json.dumps(record, ensure_ascii=False) + '\n' for record in records), encoding='utf-8')
    print(json.dumps({'records': len(records), 'benchmarkReports': sum(r.get('metrics', {}).get('kind') == 'streaming-benchmark' for r in records), 'output': str(args.output)}))
