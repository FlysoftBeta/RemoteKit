"""Evaluate the production YuNet/SFace gates on the fixed LFW pairs."""
import argparse
from collections import Counter
import hashlib
import json
import math
from pathlib import Path
import tarfile
import time

import cv2
import numpy as np


ARCHIVE_SHA = "055f7d9c632d7370e6fb4afc7468d40f970c34a80d4c6f50ffec63f5a8d536c0"
PAIRS_SHA = "ea42330c62c92989f9d7c03237ed5d591365e89b3e649747777b70e692dc1592"
THRESHOLD = 0.50


def verify_hash(path, expected):
    with path.open("rb") as source:
        actual = hashlib.file_digest(source, "sha256").hexdigest()
    if actual != expected:
        raise ValueError(f"SHA-256 mismatch for {path}: {actual}")


def image_name(identity, number):
    return f"lfw/{identity}/{identity}_{int(number):04d}.jpg"


def read_pairs(path):
    lines = path.read_text(encoding="ascii").splitlines()
    if lines[0].split() != ["10", "300"] or len(lines) != 6001:
        raise ValueError("Expected the standard LFW 6000 pairs")
    for line in lines[1:]:
        columns = line.split()
        if len(columns) == 3:
            identity, first, second = columns
            yield True, image_name(identity, first), image_name(identity, second)
        else:
            first_identity, first, second_identity, second = columns
            yield False, image_name(first_identity, first), image_name(second_identity, second)


def encode(jpeg, detector, recognizer):
    bgr = cv2.imdecode(np.frombuffer(jpeg, np.uint8), cv2.IMREAD_COLOR)
    if bgr is None:
        return "decode_failure", None
    rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
    bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
    height, width = bgr.shape[:2]
    detector.setInputSize((width, height))
    _, detections = detector.detect(bgr)
    if detections is None or not len(detections):
        return "no_detection", None
    if len(detections) != 1:
        return "multiple_detections", None
    face = detections[0]
    if not np.isfinite(face).all():
        return "nonfinite_detection", None
    x, y, w, h = face[:4]
    if x < 0 or y < 0 or w < 64 or h < 64 or x + w >= width or y + h >= height:
        return "bbox_gate", None
    if face[14] < np.float32(0.90):
        return "confidence_gate", None
    features = recognizer.feature(recognizer.alignCrop(bgr, face)).ravel()
    if features.dtype != np.float32 or features.size != 128:
        raise ValueError("Invalid SFace feature type or shape")
    features = features.astype(np.float64)
    norm = float(np.dot(features, features))
    if not math.isfinite(norm) or norm <= 1e-12:
        return "invalid_embedding", None
    return "encoded", (features / math.sqrt(norm)).astype(np.float32)


def rate(count, total):
    if not total:
        return None
    fraction = count / total
    z = 1.959963984540054
    scale = 1 + z * z / total
    midpoint = (fraction + z * z / (2 * total)) / scale
    radius = z * math.sqrt((fraction * (1 - fraction) + z * z / (4 * total)) / total) / scale
    return {
        "count": count,
        "total": total,
        "value": fraction,
        "wilson95": [max(0, midpoint - radius), min(1, midpoint + radius)],
    }


def summarize(pairs, features):
    scores = {True: [], False: []}
    counts = Counter()
    missing = Counter()
    for same, first, second in pairs:
        lhs, rhs = features[first], features[second]
        match = False
        if lhs is None or rhs is None:
            missing[same] += 1
        else:
            # Endpoint adds float32 products in sequence.
            score = float(np.add.accumulate(lhs * rhs)[-1])
            scores[same].append(score)
            match = score >= THRESHOLD
        counts[same, match] += 1

    result = {}
    for conditional in (False, True):
        tp, fn = counts[True, True], counts[True, False]
        fp, tn = counts[False, True], counts[False, False]
        if conditional:
            fn -= missing[True]
            tn -= missing[False]
        result["conditional" if conditional else "fail_closed"] = {
            "confusion": {"tp": tp, "tn": tn, "fp": fp, "fn": fn},
            "accuracy": rate(tp + tn, tp + tn + fp + fn),
            "far": rate(fp, fp + tn),
            "frr": rate(fn, tp + fn),
        }
    for same, label in ((True, "same"), (False, "different")):
        values = scores[same]
        result[label] = {
            "coverage": rate(len(values), len(values) + missing[same]),
            "score_mean": float(np.mean(values)) if values else None,
            "score_quantiles_0_1_5_25_50_75_95_99_100": np.percentile(
                values, [0, 1, 5, 25, 50, 75, 95, 99, 100]
            ).tolist() if values else None,
        }
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", required=True, type=Path)
    parser.add_argument("--pairs", required=True, type=Path)
    parser.add_argument("--models", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    verify_hash(args.archive, ARCHIVE_SHA)
    verify_hash(args.pairs, PAIRS_SHA)
    manifest = json.loads(Path(__file__).with_name("face-auth-deps.json").read_text())
    for name in ("yunet.onnx", "sface.onnx"):
        verify_hash(args.models / name, manifest["zoo"][name][1])
    if cv2.__version__ != manifest["opencv"]["version"]:
        raise ValueError(f"Expected production OpenCV version, got {cv2.__version__}")
    cv2.setNumThreads(1)
    cv2.ocl.setUseOpenCL(False)
    detector = cv2.FaceDetectorYN.create(str(args.models / "yunet.onnx"), "", (320, 320), 0.75, 0.3, 100)
    recognizer = cv2.FaceRecognizerSF.create(str(args.models / "sface.onnx"), "")
    pairs = list(read_pairs(args.pairs))
    needed = {name for _, first, second in pairs for name in (first, second)}
    features = {}
    image_status = Counter()
    started = time.monotonic()
    with tarfile.open(args.archive, "r|gz") as archive:
        for member in archive:
            name = member.name.removeprefix("./")
            if name not in needed:
                continue
            if not member.isfile() or name in features:
                raise ValueError(f"Invalid archive entry: {name}")
            with archive.extractfile(member) as image:
                status, features[name] = encode(image.read(), detector, recognizer)
            image_status[status] += 1
            if len(features) % 500 == 0:
                print(f"{len(features)}/{len(needed)} images", flush=True)
    if features.keys() != needed:
        raise ValueError(f"Missing {len(needed - features.keys())} pair images")
    report = summarize(pairs, features)
    report.update(
        image_status=image_status,
        image_coverage=rate(image_status["encoded"], len(needed)),
        threshold=THRESHOLD,
        opencv=cv2.__version__,
        numpy=np.__version__,
        inference_wall_seconds=round(time.monotonic() - started, 2),
    )
    args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
