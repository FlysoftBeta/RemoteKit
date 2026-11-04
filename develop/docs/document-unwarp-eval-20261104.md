# UVDoc 部分入镜实验

2026-11-04。UVDoc 能减轻合成弯页的行弧，但官方输出会从部分入镜画面裁掉边缘内容，本批不接入。现有保色扫描可保留未能可靠校正的几何，书页展平和严重截断透视仍待解决。

## 工件和运行边界

- [PaddlePaddle 官方 UVDoc ONNX](https://huggingface.co/PaddlePaddle/UVDoc_onnx/tree/3bcf535371727d11e783101f79a504c68848aae3) 模型卡标 Apache-2.0。实际下载 `inference.onnx` 31,684,150 bytes，SHA-256 `54cab30dc2cf347b4f3d6971c833b1c3d84f5ef17280f1f6d15796bff20e63d6`。与作者 PyTorch 工件分别记录，未来分发应保留许可和来源。
- [UVDoc 作者仓库](https://github.com/tanguymagne/UVDoc/tree/4c9b82b537057aff2526e6dd118a847cdd072e82) 根许可 MIT，仓库随附 `model/best_model.pkl` 32,158,393 bytes，README 的 demo 明确使用它。未找到 checkpoint 专属许可声明。作者 demo 的可转换路径是导出固定输入的网络网格，另行重采样原图，本轮未执行 PyTorch 导出。
- 官方 ONNX 在 ONNX Runtime 1.31.1 CPU 上运行。OpenCV 4.11.0 wheel 原始导入在首个 `Shape` 拒绝动态高宽。固定 `1×3×712×488` 后，整图导入在 `GridSample` 失败。截取固定网格子图后可导入，forward 在 5D reflect `Pad` 报 `inputs[0].dims == 4`。后续若有需要，可研究等价的 4D Pad 与外部双线性重采样，仍需做数值对比和 Endpoint 原生验收。这些结果只覆盖同版本 Python wheel。

## 几何与内容保全

使用 depot_tools Python 3.11、OpenCV 4.11.0.86、ONNX Runtime CPU。依照 [PaddleX 的官方前处理](https://github.com/PaddlePaddle/PaddleX/blob/ffb64904d23708863ff5b8da312a5cbd52a7f462/paddlex/inference/models/image_unwarping/predictor.py) 直接输入 BGR NCHW float，除以 255。模型将网络输入缩至 712×488，并输出 45×31 的反向采样网格。正式输出通过双线性将网格插值到输入大小，再从原 RGB 像素采样。实验在图的原输出之外暴露低分辨率网格，将网格小四边形栅格化到输入坐标的 501² 蒙版，估计覆盖百分比。覆盖包括背景，无法单独证明文字丢失。输出保留色彩，没有二值化或校光，收据褐色热变色仍可辨。

| 输入 | 输入覆盖 | 可见绿边缘标记，输入 → 输出 | 几何与细节 |
| --- | ---: | ---: | --- |
| 1200×900 直的部分页 | 83.32% | 8 → 1 | 三条水平线中一条被旋转约 1.07° |
| 同页加 24 px 正弦形变 | 78.75% | 8 → 0 | 三条行线去除最佳拟合直线后的纵向残差约 7.2–7.6 → 2.3–3.2 px |
| 同页做截断透视 | 86.83% | 3 → 1 | 三条线倾角约 −3.15/−0.93/+1.44° → +1.47/+0.63/+0.66°，首行残差 1.24 → 4.50 px |
| 2200×1461 实拍打开的弯书 | 57.46% | — | 侧视、正文失焦，输出保留原有书脊，不能评价文字行展平 |
| 1600×1200 实拍热敏收据 | 60.73% | — | 右边已截断的文字进一步丢失，画面仍包含手和背景 |

三个合成输入使用上一轮的部分页，加入三条彩色测量线和八个距画框 14 px 的绿色圆标。圆标统计为阈值后连通面积大于 20 px；截断透视先变换，再计实际输入中剩余标记。透视和曲面样本使用边界反射填充。实拍沿用 [Ben White 的弯书照片](https://en.wikibooks.org/wiki/File:Open_book_(Unsplash).jpg) 和 [Tijmen Stam 的热敏收据](https://commons.wikimedia.org/wiki/File:Thermal_paper.jpg)。后者右边覆盖蒙版与近画框文字相交。五张图不能代表一般拍摄分布，但三个合成样本和收据都给出了已入镜内容被裁的反例。根据局部网格延伸到输入画框或拒绝低覆盖结果属于不同算法，尚未验证其稳定性。

## CPU 与本地复现

Windows i7-10700，ORT CPU intra-op 4 线程，OpenCV 1 线程，关闭 OpenCL。用原始 ONNX 分别启动两个进程，各做 5 次，首轮之后取中位数，包含 blob 构造、推理和输出 uint8 转换，排除 PNG 读写、session 创建和扫描增强。3.21 MP 弯书约 314.6 ms，进程峰值工作集 372.5 MiB；1.92 MP 收据约 196.6 ms，峰值工作集 255.4 MiB。峰值含 Python、依赖和已解码输入，启动 session 前 RSS 分别为 62.2/58.7 MiB。两次 session 创建约 112/109 ms。这些是模型实验数据，未测原生 Endpoint worker 和多租户。

脚本、模型、依赖和预览留在 `develop/tmp/document-unwarp-eval-20261104/`。`probe.py` 生成五张原图、输出与未覆盖区域红色叠图的拼接预览，打印边缘标记、行角和网格覆盖。`bench.py book` 与 `bench.py receipt` 测原始模型，`static.py` 重现三类 OpenCV 阻碍中的静态整图及固定网格两类。输入和 OpenCV wheel 复用 `develop/tmp/document-scan-research-20261104/`。
