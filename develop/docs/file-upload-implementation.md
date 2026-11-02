# 文件后端与统一声道设置实施记录

2026-11-02。本文记录本批代码与验证，不把原生编译或模型通过写成真实网页上传通过。音频媒体链、客户端文件/拍照UI由各自owner实现；本批仅包含统一设置存储和文件后端。

## 产品与公开接口

`ProductSettings.audioChannels={left,right}`默认均为true。Control每次验证并保存完整bool二元组，适用于全部Window/当前Viewer；旧设置记录缺少该字段时补默认值。SQLite失败不发布未保存状态。客户端不保存设置副本作为真相。

`ProductState.fileRequests`独立于JS `pageDialogs`，每项含opaque `id`、`tabId/windowId`、origin、multiple、accept、pending/validating及固定limits。ID绑定Tenant、Browser incarnation、view、instance、document和Browser本地请求；内部binding不发给Viewer。`accept`是Chrome picker提示，不作内容安全或申报MIME过滤。目录选择仍明确不支持。

| 接口 | 行为 |
| --- | --- |
| WS `files.begin {requestId,files:[{name,size,type}]}` | 重新检查当前pending chooser，返回`{uploadId,files:[{ticket,url}]}`。同一pending重试前废弃旧未提交batch；提交结果未定时拒绝新batch。 |
| POST `/api/files/{ticket}` | cookie、Origin、octet-stream校验。ticket绑定创建WS lease和token身份，每段重新检查仍current/auth有效；不加公开lease header。流式写入Endpoint给出的私有文件，关闭writer后204。204仅代表完整传输。 |
| WS `files.commit {uploadId}` | 仅所有文件完整后封存并一次提交原生chooser；重复调用查询同一操作，返回selected/validating/cancelled，不重复交付文件。 |
| WS `files.cancel {requestId,uploadId?}` | 用户明确取消chooser；validating允许原生取消。selected保持selected，未知结果保持validating，不能假报已取消。 |

文件名与MIME仅为有界元数据；文件路径只能由Endpoint分配，不接受客户端服务器path。文件名保存在原生`NativeFileInfo.display_name`，磁盘随机名不改变网页`File.name`。固定上限为每文件256MiB、每batch512MiB/64文件、Session1GiB；另有内部Session总4096文件限制，防止零字节文件无限堆积。测试可构造小限额，无调参UI。

## 分层与生命周期

Control `FileUploads`管理ticket、身份和有界传输/确认记录。HTTP原始body不经过JSON或base64聚合，逐段检查字节数与授权。失败、长度错误、超限、lease丢失清理未提交batch并保留原生pending chooser；新Viewer重新看到请求，旧ticket不能继承。显式取消按钮才取消chooser。Tenant serial队列在替换Viewer可开始新batch之前revoke旧lease，防止旧清理扫掉新上传。

Endpoint `FileUploadStore`是Session私有C++ helper，不跨SDK DLL。内部RPC为`session.files.begin/commit/status/cancel/revoke`，全部noStart，实际受理时复查Browser incarnation及view/instance/document/request。服务集成由音频native owner完成。

文件状态为uploading→sealed→submitted→selected。Control先关闭全部writer，Endpoint检验实际普通文件及精确长度，再在同目录rename封存。提交前标记submitted；已可能交付给Browser而结果未知时保留，不以网络错误当取消，也不回放新的chooser reply。选中文件可被页面延迟读取，导航、Control断开和TTL均不删除。只有所属Browser incarnation实际进程退出被确认，才能清理该owner持有的选择；新Endpoint无法声称未知旧Browser已停止。

Browser保留原来的ThreadPool异步文件验证和WeakDocumentPtr复查，文件验证后才调用真实`FileSelectListener::FileSelected`。明确cancel先移除pending，异步callback找不到请求就不再选择。`page.fileStatus`返回pending/validating及最多64个完成结果。未知、真实拒绝和实际selected分开；选择成功不等于页面已经消费上传内容。

## 跨重启配额与Windows路径

每个随机batch目录写一份小型`v1 declaredBytes declaredFiles` reservation，无凭据、产品身份或客户端path。新Endpoint只读扫描自有32/64hex owner/batch目录，按每batch `max(声明量, 实际payload量)`汇总字节和文件数，避免双计，且保留未确认旧Browser的数据。扫描不跟随symlink/reparse；未知命名目录不遍历。损坏/缺失reservation、异常payload、访问错误或超过65536项扫描界限均保守饱和配额，拒绝新分配，不能静默归零。未知旧owner的数据不因重启自动删除，因此保留量可能持续占用配额。

首次Release测试暴露真实MAX_PATH问题：三段64hex与TEMP/Session根叠加使fstream创建失败。现随机ID为128bit/32hex，且Endpoint私有绝对Windows路径规范为extended路径（含UNC），不依赖宿主longPathsEnabled。覆盖真实>260字符根的创建、写入、封存、删除；测试清理仍先验证绝对路径、真实Temp父目录身份和自有随机名称。

## 本批验证

- `cd control; npx tsx --test test/audio-channel-settings.test.ts test/file-uploads.test.ts test/reply-lifecycle.test.ts`：14/14通过。包括旧设置迁移/原子保存、失败持久化、流式分段/截断/重复ticket、租户/token/lease替换、cookie/Origin真实HTTP路由、accept提示、真实Control opaque请求与Browser替换/接管。
- 后续只增补取消结果未知回归，`npx tsx --test test/file-uploads.test.ts`为8/8通过，验证有/无uploadId都不虚报取消；未重跑无关组。
- `cd control; npx tsc --noEmit`通过。
- 统一native Browser+SDK/Endpoint Release由音频owner完成；其他10套CPU测试在该统一批通过。helper后续定向增量`endpoint_file_upload`通过，0.08秒，覆盖核心状态、长根路径、跨重启旧选择保留、零字节数量配额、partial实际量大于声明、损坏/缺失reservation及未知目录保留。未为无关组重复构建/测试。
- 实际网页chooser→上传→页面File.name/内容及导航/异步取消验证尚由最终功能QA执行；以上结果不能替代该证据，也不代表实体摄像头体验验证。

主要文件：`control/server/file-uploads.ts`、`control/server/control.ts`、`control/server/http.ts`、`control/server/store.ts`、`control/shared/product.ts`；`browser/page_requests.*`；`endpoint/include/remotekit/file_upload.hpp`、`endpoint/src/file_upload.cpp`及其CPU测试。服务/harness/CMake薄适配由native owner提供。
