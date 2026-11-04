#!/usr/bin/env python3
"""Provision the Windows x64 Endpoint face models and OpenCV runtime."""

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import urllib.request
import zipfile

TOOLS = Path(__file__).resolve().parent
MANIFEST = TOOLS / "face-auth-deps.json"
DEPS = TOOLS.parent / "build" / "dependencies" / "face-auth"
MODELS = DEPS / "face-models"
CACHE = DEPS / "cache"
CONFIG = json.loads(MANIFEST.read_text(encoding="utf-8"))


def digest(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def verify(path, expected):
    if not path.is_file() or digest(path) != expected:
        raise RuntimeError(f"Missing file or SHA-256 mismatch: {path}")


def download(url, destination, expected):
    if destination.is_file() and digest(destination) == expected:
        return
    destination.parent.mkdir(parents=True, exist_ok=True)
    partial = destination.with_name(destination.name + ".partial")
    try:
        with urllib.request.urlopen(url, timeout=90) as source, partial.open("wb") as output:
            shutil.copyfileobj(source, output)
        verify(partial, expected)
        partial.replace(destination)
    finally:
        partial.unlink(missing_ok=True)


def runtime_files():
    """Return verified source/package destination pairs without network access."""
    entries = []
    for name, (path, expected) in CONFIG["opencv"]["licenses"].items():
        source = CACHE / f'opencv-{CONFIG["opencv"]["version"]}' / path
        verify(source, expected)
        entries.append((source, Path("licenses") / name))
    models = {name: item[1] for name, item in CONFIG["zoo"].items()}
    models.update(CONFIG["converted"])
    models["minifas-LICENSE.txt"] = CONFIG["minifas"]["minifas-LICENSE.txt"][1]
    for name, expected in models.items():
        source = MODELS / name
        verify(source, expected)
        entries.append((source, Path("bin/face-models") / name))
    entries.append((MANIFEST, Path("bin/face-models/provenance.json")))
    return entries


def msvc_tools():
    vs = Path(os.environ.get("REMOTEKIT_VS",
                             r"C:\Program Files\Microsoft Visual Studio\18\Community"))
    tool_root = vs / "Common7/IDE/CommonExtensions/Microsoft/CMake"
    cmake = tool_root / "CMake/bin/cmake.exe"
    ninja = tool_root / "Ninja/ninja.exe"
    if not cmake.is_file() or not ninja.is_file():
        raise RuntimeError(f"Missing Visual Studio CMake/Ninja under {tool_root}")
    if os.environ.get("VSCMD_ARG_TGT_ARCH") == "x64":
        env = os.environ.copy()
    else:
        dev_cmd = vs / "Common7/Tools/VsDevCmd.bat"
        command = f'cmd.exe /d /u /c call "{dev_cmd}" -arch=x64 -host_arch=x64 >nul && set'
        values = subprocess.check_output(command).decode("utf-16le")
        env = dict(line.split("=", 1) for line in values.splitlines()
                   if "=" in line and not line.startswith("="))
    env["VSLANG"] = "1033"
    return cmake, ninja, env


def install_opencv():
    opencv = CONFIG["opencv"]
    source = CACHE / f'opencv-{opencv["version"]}'
    archive = CACHE / f"{source.name}.zip"
    download(opencv["url"], archive, opencv["sha256"])
    marker = source / ".remotekit-source-sha256"
    if not marker.is_file() or marker.read_text(encoding="ascii") != opencv["sha256"]:
        with zipfile.ZipFile(archive) as package:
            package.extractall(CACHE)
        marker.write_text(opencv["sha256"], encoding="ascii")
    for path, expected in opencv["licenses"].values():
        verify(source / path, expected)
    cmake, ninja, env = msvc_tools()
    build = DEPS / "opencv-build"
    install = DEPS / "opencv-static"
    disabled = (
        "BUILD_SHARED_LIBS", "BUILD_WITH_STATIC_CRT", "BUILD_TESTS", "BUILD_PERF_TESTS",
        "BUILD_EXAMPLES", "BUILD_DOCS", "BUILD_JAVA", "BUILD_opencv_apps",
        "BUILD_opencv_python2", "BUILD_opencv_python3", "BUILD_opencv_world",
        "WITH_OPENCL", "WITH_OPENGL", "WITH_DIRECTX", "WITH_FFMPEG",
        "WITH_MSMF", "WITH_DSHOW", "WITH_WIN32UI", "WITH_IPP", "WITH_ITT", "WITH_ADE",
        "WITH_LAPACK", "WITH_EIGEN", "WITH_FLATBUFFERS", "WITH_VULKAN", "WITH_TBB",
        "WITH_OPENMP", "WITH_QUIRC", "WITH_TENGINE", "WITH_CUDA",
        "WITH_JPEG", "WITH_PNG", "WITH_TIFF", "WITH_WEBP", "WITH_OPENJPEG",
        "WITH_JASPER", "WITH_OPENEXR", "WITH_GIF", "WITH_AVIF", "WITH_GSTREAMER",
    )
    subprocess.run([str(cmake), "-S", str(source), "-B", str(build), "-G", "Ninja",
                    f"-DCMAKE_MAKE_PROGRAM={ninja}", "-DCMAKE_BUILD_TYPE=Release",
                    f"-DCMAKE_INSTALL_PREFIX={install}", "-DBUILD_LIST=core,imgproc,dnn,objdetect",
                    "-DOPENCV_SKIP_CMAKE_ROOT_CONFIG=ON", "-DOPENCV_CONFIG_INSTALL_PATH=cmake",
                    "-DWITH_PROTOBUF=ON", "-DBUILD_PROTOBUF=ON", "-DBUILD_ZLIB=ON",
                    *[f"-D{option}=OFF" for option in disabled]], check=True, env=env)
    subprocess.run([str(cmake), "--build", str(build), "--parallel", str(os.cpu_count() or 1),
                    "--target", "install"], check=True, env=env)


def export_minifas(source, output):
    import cv2
    import numpy as np
    import onnx
    import torch

    if (torch.__version__, onnx.__version__, cv2.__version__, np.__version__) != (
            "2.6.0+cpu", "1.17.0", "4.11.0", "1.26.4"):
        raise RuntimeError("Unexpected model export tool versions")
    torch.set_num_threads(1)
    cv2.setNumThreads(1)
    spec = importlib.util.spec_from_file_location("upstream_minifas", source / "MiniFASNet.py")
    upstream = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(upstream)
    rng = np.random.default_rng(829)
    cases = [np.zeros((1, 3, 80, 80), dtype=np.float32),
             np.full((1, 3, 80, 80), 127, dtype=np.float32)]
    cases.extend(rng.integers(0, 256, (1, 3, 80, 80)).astype(np.float32) for _ in range(12))
    for name, factory in (("minifas-v1se", upstream.MiniFASNetV1SE),
                          ("minifas-v2", upstream.MiniFASNetV2)):
        model = factory(conv6_kernel=(5, 5))
        weights = torch.load(source / f"{name}.pth", map_location="cpu", weights_only=True)
        model.load_state_dict({key.removeprefix("module."): value for key, value in weights.items()})
        model.eval()
        target = output / f"{name}.onnx"
        with torch.inference_mode():
            torch.onnx.export(model, torch.from_numpy(cases[0]), str(target), opset_version=13,
                              input_names=["bgr"], output_names=["logits"], dynamo=False)
            onnx.checker.check_model(str(target))
            net = cv2.dnn.readNetFromONNX(str(target))
            max_error = 0.0
            for sample in cases:
                expected = model(torch.from_numpy(sample)).numpy()
                net.setInput(sample)
                actual = net.forward()
                np.testing.assert_allclose(actual, expected, rtol=1e-4, atol=5e-4)
                max_error = max(max_error, float(np.max(np.abs(actual - expected))))
        print(f"{name}: {len(cases)} OpenCV/PyTorch comparisons, max logit error {max_error:.8g}")
        print(f"{target.name} SHA-256 {digest(target)}")


def install_models():
    commit = CONFIG["zoo_commit"]
    for name, (path, expected) in CONFIG["zoo"].items():
        if name.endswith(".onnx"):
            url = f"https://media.githubusercontent.com/media/opencv/opencv_zoo/{commit}/models/{path}"
        else:
            url = f"https://raw.githubusercontent.com/opencv/opencv_zoo/{commit}/models/{path}"
        download(url, MODELS / name, expected)

    commit = CONFIG["minifas_commit"]
    for name, (path, expected) in CONFIG["minifas"].items():
        directory = MODELS if name.endswith("LICENSE.txt") else CACHE
        download(f"https://raw.githubusercontent.com/minivision-ai/Silent-Face-Anti-Spoofing/{commit}/{path}",
                 directory / name, expected)

    try:
        for name, expected in CONFIG["converted"].items():
            verify(MODELS / name, expected)
        return
    except RuntimeError:
        pass

    target = CACHE / "python"
    if not (target / "torch").is_dir():
        subprocess.run([sys.executable, "-m", "pip", "install", "--target", str(target),
                        "torch==2.6.0+cpu", "--index-url", "https://download.pytorch.org/whl/cpu"],
                       check=True)
    if not (target / "onnx").is_dir():
        subprocess.run([sys.executable, "-m", "pip", "install", "--target", str(target),
                        "onnx==1.17.0", "opencv-python==4.11.0.86", "numpy==1.26.4"], check=True)
    sys.path.insert(0, str(target))
    with tempfile.TemporaryDirectory(prefix="convert-", dir=CACHE) as temporary:
        output = Path(temporary)
        export_minifas(CACHE, output)
        for name, expected in CONFIG["converted"].items():
            verify(output / name, expected)
        for name in CONFIG["converted"]:
            (output / name).replace(MODELS / name)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verify", action="store_true", help="verify existing runtime files offline")
    args = parser.parse_args()
    if not args.verify:
        install_opencv()
        install_models()
    print(f"Verified {len(runtime_files())} face-auth runtime files in {DEPS}")


if __name__ == "__main__":
    main()
