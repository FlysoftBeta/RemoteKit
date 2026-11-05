"""Compare FA1 and shared-engine FA2 numeric results without opening images."""
import argparse
import csv
from pathlib import Path


def load(root, name):
    with (root / name).open(newline="") as stream:
        return [{key: float(value) for key, value in row.items()}
                for row in csv.DictReader(stream)]


def fraction(numerator, denominator):
    return f"{numerator}/{denominator} ({100 * numerator / denominator:.2f}%)"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--private-root", type=Path, required=True)
    args = parser.parse_args()
    private = args.private_root.resolve(strict=True)
    before = private / "fa1-numeric"
    after = private / "fa2-numeric"
    lines = []

    def table(header, rows):
        lines.append("| " + " | ".join(map(str, header)) + " |")
        lines.append("|" + "|".join(["---"] * len(header)) + "|")
        for row in rows:
            lines.append("| " + " | ".join(map(str, row)) + " |")
        lines.append("")

    old_frames = load(before, "frames.csv")
    new_frames = load(after, "frames.csv")
    rows = []
    for width in [640, 480, 320]:
        for variant, label in [(0, "base"), (1, "blur sigma=1"),
                               (2, "brightness x0.7"), (3, "brightness x1.3"),
                               (4, "JPEG q60"), (None, "all variants")]:
            old = [r for r in old_frames if r["width"] == width and
                   (variant is None or r["variant"] == variant)]
            new = [r for r in new_frames if r["width"] == width and
                   (variant is None or r["variant"] == variant)]
            rows.append([f"{width}x{width*3//4}", label,
                         fraction(sum(r["gate_mask"] == 0 for r in old), len(old)),
                         fraction(sum(r["gate"] == 0 for r in new), len(new)),
                         fraction(sum(int(r["gate_mask"]) & 63 != 0 for r in old), len(old)),
                         fraction(sum(r["gate"] in [1, 2, 3, 4] for r in new), len(new))])
    table(["size", "degradation", "accepted before", "accepted after",
           "detection failures before", "detection failures after"], rows)

    rows = []
    for label, root, legacy in [("FA1", before, True), ("FA2", after, False)]:
        pairs = load(root, "lfw_pairs.csv")
        images = load(root, "lfw_images.csv")
        failed = sum(r["detection_gate"] != 0 if legacy else not r["detected"] for r in images)
        for threshold in [0.45, 0.50]:
            for detected_only in [True, False]:
                selected = [r for r in pairs if not detected_only or r["both_detected"]]
                negatives = [r for r in selected if not r["same"]]
                positives = [r for r in selected if r["same"]]
                far = sum(bool(r["both_detected"]) and r["cosine"] >= threshold for r in negatives)
                frr = sum(not r["both_detected"] or r["cosine"] < threshold for r in positives)
                rows.append([label, threshold, "detected pairs" if detected_only else "all pairs",
                             fraction(far, len(negatives)), fraction(frr, len(positives)),
                             fraction(failed, len(images))])
    table(["pipeline", "cosine threshold", "denominator", "FAR", "FRR",
           "image detection failures"], rows)

    old_sequences = load(before, "sequences.csv")
    new_sequences = load(after, "sequences.csv")
    rows = []
    for r in new_sequences:
        old = [x for x in old_sequences if x["width"] == r["width"]]
        rows.append([int(r["width"]), fraction(sum(x["matched_at_ms"] >= 0 for x in old), len(old)),
                     fraction(int(r["matched"]), int(r["verification_sequences"]))])
    table(["width", "sequence successes before", "sequence successes after"], rows)
    lines.append("Identity FAR/FRR excludes liveness. All-pair FRR includes detection failures. "
                 "Sequence denominators change when enrollment detection coverage changes.")
    text = "\n".join(lines)
    (after / "report.md").write_text(text, encoding="utf-8")
    print(text)


if __name__ == "__main__":
    main()
