# LFW 公开人物照片同人比对评测

2026-11-04，RemoteKit 开发机，CPU 单线程。使用 Labeled Faces in the Wild 的原始彩色 250×250 JPEG 和官方固定 10 折配对，共 6,000 对（3,000 同人、3,000 异人）。先固定 Endpoint 余弦阈值 0.50，再运行完整配对。以数据自带标签判定真值，无人工补标、样本剔除、训练或阈值拟合。[Huang 等，UMass Amherst 技术报告 07-49](https://people.cs.umass.edu/~elm/papers/lfw.pdf) · [scikit-learn 固定资源](https://github.com/scikit-learn/scikit-learn/blob/main/sklearn/datasets/_lfw.py)

## 输入与执行

| 资产 | 固定版本 | SHA-256 |
| --- | --- | --- |
| 原始 [lfw.tgz](https://ndownloader.figshare.com/files/5976018) | [Figshare v2](https://doi.org/10.6084/m9.figshare.3829986.v2) | `055f7d9c632d7370e6fb4afc7468d40f970c34a80d4c6f50ffec63f5a8d536c0` |
| 固定 [pairs.txt](https://ndownloader.figshare.com/files/5976006) | [Figshare v3](https://doi.org/10.6084/m9.figshare.3829971.v3) | `ea42330c62c92989f9d7c03237ed5d591365e89b3e649747777b70e692dc1592` |

Figshare 的两个记录均标记 CC BY 4.0。原始新闻照片涉及原权利人的权利，评测仅在本地读取，提交中只包含代码和聚合结果。[Figshare 图像元数据](https://api.figshare.com/v2/articles/3829986) · [Figshare 配对元数据](https://api.figshare.com/v2/articles/3829971) · [Datasheets for Datasets 的 LFW 附录](https://www.microsoft.com/en-us/research/uploads/prod/2019/01/1803.09010.pdf)

OpenCV Python 4.11.0 使用与 Endpoint 一致的 YuNet 2023mar 和 SFace 2021dec，脚本按 [模型清单](../../tools/face-auth-deps.json) 校验权重。JPEG 解码后以原尺寸彩色 RGB24 进入计算，转 BGR 后用 YuNet（score 0.75、NMS 0.30、topK 100）。需恰好一张脸，检测置信度 ≥0.90，框宽高均 ≥64、坐标有界。五点 `alignCrop` 后提取 128 维 SFace 特征、L2 归一化，余弦 ≥0.50 判为同人。每张不同的照片仅推理一次。按配对计分时任一侧未提取特征则拒绝。另算双侧均有特征时的条件指标。

```powershell
$env:PYTHONPATH = (Resolve-Path build/dependencies/face-auth/cache/python).Path
$env:OPENBLAS_NUM_THREADS = '1'
& C:/src/depot_tools/python3.bat tools/benchmark-face-recognition.py `
  --archive develop/tmp/face-public-benchmark/lfw.tgz `
  --pairs develop/tmp/face-public-benchmark/pairs.txt `
  --models build/dependencies/face-auth/face-models `
  --output develop/tmp/face-public-benchmark/report.json
```

## 结果

全部 6,000 对涉及 7,701 张不同的照片。6,362 张提取成功，覆盖率 82.61%（95% 区间 81.75–83.44%）。1,287 张检测到多张脸，51 张未达最终置信度门槛，1 张未通过检测框门槛。双侧均可提取特征的配对共 4,130 对。同人覆盖 2,045/3,000（68.17%，95% 区间 66.48–69.81%），异人覆盖 2,085/3,000（69.50%，95% 区间 67.83–71.12%）。

| 口径 | TP / TN / FP / FN | 准确率（95% 区间） | FAR（95% 区间） | FRR（95% 区间） |
| --- | --- | --- | --- | --- |
| 全部配对，缺特征即拒绝 | 1864 / 3000 / 0 / 1136 | 81.07%（80.06–82.04%） | 0/3000（0–0.128%） | 37.87%（36.15–39.62%） |
| 双侧均有特征 | 1864 / 2085 / 0 / 181 | 95.62%（94.95–96.20%） | 0/2085（0–0.184%） | 8.85%（7.70–10.16%） |

全量 1,136 次同人拒绝中，955 次源于至少一张照片未通过特征提取门禁，另 181 次余弦未达到阈值。

| 余弦分数 | 均值 | 最小 | p1 | p5 | p25 | 中位数 | p75 | p95 | p99 | 最大 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 同人（2,045 对） | 0.6574 | 0.0457 | 0.3425 | 0.4563 | 0.5887 | 0.6686 | 0.7360 | 0.8265 | 0.8882 | 0.9441 |
| 异人（2,085 对） | 0.0839 | -0.2328 | -0.1272 | -0.0594 | 0.0230 | 0.0818 | 0.1441 | 0.2338 | 0.2989 | 0.4035 |

NumPy 1.26.4。单线程遍历归档和推理用时 274.3 秒，与其他构建任务共用开发机，耗时仅供复现实验估算。

区间使用逐对 Wilson 95% 区间。LFW 配对可能共享照片和人物，区间是描述性估计。公开新闻照片的构图、分辨率和人群分布有其偏向。此处是固定阈值单图比对，生产登记和验证另有多帧门禁。MiniFAS 活体、浏览器采集和 DataChannel 授权由单独验收覆盖，LFW 数值只能描述识别阶段。
