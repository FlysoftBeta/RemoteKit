"""Attribute Windows GPU/CPU samples to a saved streaming case's real interval."""
import argparse
import collections
import json
import statistics
from pathlib import Path
from streaming_metrics import load_metrics


def summary(values):
    values = sorted(v for v in values if isinstance(v, (int, float)))
    if not values:
        return None
    return {"n": len(values), "mean": statistics.mean(values),
            "p50": values[round((len(values)-1)*.50)],
            "p95": values[round((len(values)-1)*.95)], "max": values[-1]}


def analyze(case):
    metrics = [record.get("metrics", {}) for record in
               load_metrics(case/"metrics/client-metrics.jsonl")]
    clients = [m for m in metrics if m.get("kind") == "streaming-benchmark"]
    start = min(m["startedWall"] for m in clients)
    end = max(m["startedWall"]+m["elapsedMs"] for m in clients)
    samples = []
    malformed = 0
    for line in (case/"resource-samples.jsonl").read_text(encoding="utf-8").splitlines():
        try:
            sample = json.loads(line)
        except ValueError:
            malformed += 1
            continue
        if start <= sample["wallTimeMs"] <= end:
            samples.append(sample)
    if not samples:
        raise ValueError("No resource samples overlap the measurement interval")
    cpu_process = collections.defaultdict(list)
    cpu_roles = collections.defaultdict(list)
    engines = collections.defaultdict(list)
    owned_engines = collections.defaultdict(list)
    gpu_roles = collections.defaultdict(list)
    unowned_gpu = collections.defaultdict(list)
    unowned_names = collections.defaultdict(set)
    unowned_missing_names = collections.Counter()
    unowned_sample_count = sum("unownedGpu" in s for s in samples)
    for sample in samples:
        role_cpu = collections.defaultdict(float)
        role_gpu = collections.defaultdict(float)
        for cpu in sample["cpu"]:
            if cpu["cpuCores"] is not None:
                cpu_process[(cpu["pid"], cpu["role"])].append(cpu["cpuCores"])
                role_cpu[cpu["role"]] += cpu["cpuCores"]
        for role, value in role_cpu.items():
            cpu_roles[role].append(value)
        for engine in sample["engines"]:
            if engine["validInstances"]:
                engines[engine["engine"]].append(engine["totalUtilPercent"])
                owned_engines[engine["engine"]].append(engine["ownedUtilPercent"])
        for gpu in sample["gpu"]:
            if gpu["utilPercent"] is not None:
                role_gpu[(gpu["role"], gpu["engine"])] += gpu["utilPercent"]
        for key, value in role_gpu.items():
            gpu_roles[key].append(value)
        sample_unowned = collections.defaultdict(float)
        for gpu in sample.get("unownedGpu", []):
            key = (gpu["pid"], gpu["engine"])
            if gpu.get("processName"):
                unowned_names[key].add(gpu["processName"])
            else:
                unowned_missing_names[key] += 1
            if gpu["utilPercent"] is not None:
                sample_unowned[key] += gpu["utilPercent"]
        for key, value in sample_unowned.items():
            unowned_gpu[key].append(value)
    result = {"case": case.name, "wallWindowMs": [start, end],
              "sampleCount": len(samples), "malformedLines": malformed,
              "providers": sorted({s.get("gpuProvider", "cim") for s in samples}),
              "collectionMs": summary([s["collectionMs"] for s in samples]),
              "collectorCpuCores": summary([s["collectorCpuCores"] for s in samples]),
              "gpuErrors": [s["gpuError"] for s in samples if s.get("gpuError")],
              "cpuByRoleCores": {k: summary(v) for k, v in cpu_roles.items()},
              "cpuByProcessCores": [{"pid": k[0], "role": k[1], "cores": summary(v)}
                                     for k, v in cpu_process.items()],
              "gpuByPhysicalEnginePercent": {k: summary(v) for k, v in engines.items()},
              "ownedGpuByPhysicalEnginePercent": {k: summary(v) for k, v in owned_engines.items()},
              "gpuByRoleAndPhysicalEnginePercent": [
                  {"role": k[0], "engine": k[1], "percent": summary(v)}
                  for k, v in gpu_roles.items()],
              "unownedGpuSampleCount": unowned_sample_count,
              "unownedGpuByProcessAndPhysicalEnginePercent": [
                  {"pid": k[0], "engine": k[1],
                   "observedProcessNames": sorted(unowned_names[k]),
                   "missingNameObservations": unowned_missing_names[k],
                   "presentSamplesPercent": summary(v),
                   # Observed contribution normalized over recorded samples;
                   # absent instances are unknown, not measured zero busy time.
                   "observedContributionPerRecordedWindowPercent": sum(v)/unowned_sample_count}
                  for k, v in sorted(unowned_gpu.items())],
              "interpretation": "GPU engine busy is scheduler running time, not proof of shader arithmetic. Independent engines are not added. CPU cores use process CPU time / elapsed wall time; divide by logical CPUs for host percent. Missing engine instances are not measured zero. observedContributionPerRecordedWindowPercent normalizes the observed contribution over recorded unowned samples; it does not estimate utilization during missing intervals."}
    (case/"resource-summary.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    dominant = sorted(((k, v["mean"]) for k, v in result["gpuByPhysicalEnginePercent"].items()), key=lambda v: -v[1])[:3]
    print(json.dumps({"case": case.name, "samples": len(samples), "collectorCores": result["collectorCpuCores"]["mean"],
                      "collectionMs": result["collectionMs"]["mean"], "gpuEngines": dominant,
                      "cpuRoles": {k: v["mean"] for k, v in result["cpuByRoleCores"].items()}}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("cases", nargs="+", type=Path)
    for folder in parser.parse_args().cases:
        analyze(folder)
