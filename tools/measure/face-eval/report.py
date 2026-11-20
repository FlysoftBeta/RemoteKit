"""Compare numeric baseline and FA3 results; never open images or write artifacts."""
import argparse
import csv
from pathlib import Path

AXES = {0: "clean", 1: "scale", 2: "illumination", 3: "degradation"}
VARIANTS = ["clean", "IOD60", "IOD45", "IOD35", "IOD28", "IOD22",
            "gamma0.5", "gamma0.7", "gamma1.4", "gamma2.0", "exposure0.5",
            "exposure1.6", "backlight", "blur1", "blur2", "JPEG50", "noise6"]


def load(root, name):
    with (root / name).open(newline="") as stream:
        return [{key: float(value) for key, value in row.items()}
                for row in csv.DictReader(stream)]


def validate(root):
    enrollments = load(root, "enrollments.csv")
    sequences = load(root, "sequences.csv")
    frames = load(root, "frames.csv")
    images = load(root, "lfw_images.csv")
    pairs = load(root, "lfw_pairs.csv")
    if (len(enrollments) != 40 or len(sequences) != 2040 or len(frames) != 2040 or
            len(images) != 7701 or len(pairs) != 6000 or
            {r["id"] for r in images} != set(range(7701)) or
            sum(r["same"] == 1 for r in pairs) != 3000):
        raise ValueError(f"Incomplete measurement: {root.name}")
    expected = {(r["id"], photo, variant) for r in enrollments
                for photo in range(1, 5) if photo != r["photo"] for variant in range(17)}
    actual = {(r["gallery"], r["photo"], r["variant"]) for r in sequences}
    if expected != actual or any(r["elapsed_ms"] > 29800 for r in sequences):
        raise ValueError(f"Invalid verification sequences: {root.name}")
    gates = load(root, "gates.csv")
    gate_ids = {r["gate"] for r in gates}
    enrollment_gates = load(root, "enrollment_gates.csv")
    if (len(gates) != len(expected) * len(gate_ids) or not gate_ids or
            len(enrollment_gates) != len(enrollments) * len(gate_ids) or
            len(load(root, "constants.csv")) != 1):
        raise ValueError(f"Incomplete gate counts: {root.name}")
    scores = load(root, "gallery_lfw.csv")
    galleries = {r["id"] for r in enrollments if r["templates"] > 0}
    probes = {gallery: set() for gallery in galleries}
    for row in scores:
        if row["gallery"] not in probes:
            raise ValueError(f"Unexpected gallery: {root.name}")
        probes[row["gallery"]].add(row["id"])
    if len(scores) != len(galleries) * 7701 or any(
            ids != set(range(7701)) for ids in probes.values()):
        raise ValueError(f"Incomplete gallery impostors: {root.name}")


def rate(rows, field="matched"):
    return f"{sum(bool(row[field]) for row in rows)}/{len(rows)}"


def table(header, rows):
    print("| " + " | ".join(header) + " |")
    print("|" + "|".join(["---"] * len(header)) + "|")
    for row in rows:
        print("| " + " | ".join(map(str, row)) + " |")
    print()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--private-root", type=Path, required=True)
    parser.add_argument("--compare", nargs="+", default=["baseline", "fa3"])
    parser.add_argument("--match", type=float)
    parser.add_argument("--learn-floor", type=float)
    args = parser.parse_args()
    root = args.private_root.resolve(strict=True) / "fa3-numeric"
    runs = [(name, root / name) for name in dict.fromkeys(args.compare)]
    for _, path in runs:
        validate(path)
    reference = root / ("fa3" if "fa3" in args.compare else args.compare[-1])
    floor = (args.learn_floor if args.learn_floor is not None else
             load(reference, "constants.csv")[0]["learn_floor"])
    sequences = {name: load(path, "sequences.csv") for name, path in runs}
    rows = []
    for width in [480, 640]:
        for axis, label in AXES.items():
            rows.append([width, label, *[
                rate([r for r in sequences[name] if r["width"] == width and
                      r["enroll_variant"] == 0 and r["axis"] == axis])
                for name, _ in runs]])
        for variant, label in [(10, "enroll dark"), (12, "enroll backlight"),
                               (3, "enroll IOD35"), (14, "enroll blur2")]:
            rows.append([width, label, *[
                rate([r for r in sequences[name] if r["width"] == width and
                      r["enroll_variant"] == variant]) for name, _ in runs]])
        rows.append([width, "bystander clean", *[
            rate([r for r in sequences[name] if r["width"] == width and
                  r["enroll_variant"] == 0 and r["variant"] == 0 and r["photo"] == 3])
            for name, _ in runs]])
    table(["width", "axis", *[name for name, _ in runs]], rows)
    rows = []
    all_gates = {name: load(path, "gates.csv") for name, path in runs}
    for variant, label in enumerate(VARIANTS):
        row = [label]
        for name, _ in runs:
            selected = [r for r in sequences[name]
                        if r["enroll_variant"] == 0 and r["variant"] == variant]
            counts = {}
            for gate in all_gates[name]:
                if (gate["enroll_variant"] == 0 and gate["variant"] == variant and
                        gate["count"]):
                    key = int(gate["gate"])
                    counts[key] = counts.get(key, 0) + int(gate["count"])
            row.extend([rate(selected), ", ".join(
                f"{key}:{value}" for key, value in sorted(counts.items())) or "0"])
        rows.append(row)
    table(["variant (480+640)", *[column for name, _ in runs
                                 for column in (name, "gate:count")]], rows)
    rows = []
    for name, path in runs:
        gates = load(path, "gates.csv")
        for axis, label in AXES.items():
            selected = [r for r in gates if r["enroll_variant"] == 0 and
                        (0 if r["variant"] == 0 else 1 if r["variant"] <= 5 else
                         2 if r["variant"] <= 12 else 3) == axis]
            counts = {}
            for r in selected:
                if r["count"]:
                    key = int(r["gate"])
                    counts[key] = counts.get(key, 0) + int(r["count"])
            rows.append([name, label, ", ".join(f"{k}:{v}" for k, v in sorted(counts.items())) or "0"])
        enroll = load(path, "enrollments.csv")
        enrollment_gates = load(path, "enrollment_gates.csv")
        for variant, label in [(10, "enroll dark"), (12, "enroll backlight"),
                               (3, "enroll IOD35"), (14, "enroll blur2")]:
            ids = {r["id"] for r in enroll if r["variant"] == variant}
            counts = {}
            for r in enrollment_gates:
                if r["gallery"] in ids and r["count"]:
                    key = int(r["gate"])
                    counts[key] = counts.get(key, 0) + int(r["count"])
            rows.append([name, label, ", ".join(f"{k}:{v}" for k, v in sorted(counts.items())) or "0"])
        rows.append([name, "galleries", f"{sum(r['templates'] > 0 for r in enroll)}/{len(enroll)}"])
    table(["run", "axis", "gate:count"], rows)
    rows = []
    for name, path in runs:
        constants = load(path, "constants.csv")[0]
        threshold = args.match if args.match is not None else constants["match"]
        pairs = load(path, "lfw_pairs.csv")
        negatives = [r for r in pairs if not r["same"]]
        positives = [r for r in pairs if r["same"]]
        far = sum(bool(r["both_detected"]) and r["cosine"] >= threshold for r in negatives)
        frr = sum(not r["both_detected"] or r["cosine"] < threshold for r in positives)
        scores = load(path, "gallery_lfw.csv")
        match = sum(r["cosine"] >= threshold for r in scores)
        learned = sum(r["cosine"] >= floor for r in scores)
        by_gallery = {}
        for r in scores:
            counters = by_gallery.setdefault(int(r["gallery"]), [0, 0, 0])
            counters[0] += r["cosine"] >= threshold
            counters[1] += r["cosine"] >= floor
            counters[2] += 1
        worst_match = max((r[0] / r[2] for r in by_gallery.values()), default=0)
        worst_floor = max((r[1] / r[2] for r in by_gallery.values()), default=0)
        rows.append([name, f"{constants['detect']:.2f}", f"{threshold:.2f}",
                     f"{far}/{len(negatives)}", f"{frr}/{len(positives)}",
                     f"{match}/{len(scores)}", f"{learned}/{len(scores)}",
                     f"{worst_match:.8f}", f"{worst_floor:.8f}"])
        top = sorted(scores, key=lambda r: r["cosine"], reverse=True)[:10]
        print(name, "top10", " ".join(f"{r['cosine']:.6f}" for r in top))
    table(["run", "detect", "match", "pair FAR", "pair FRR", "gallery FAR match",
           f"gallery FAR floor {floor:.3f}",
           "worst gallery match", "worst gallery floor"], rows)


if __name__ == "__main__":
    main()
