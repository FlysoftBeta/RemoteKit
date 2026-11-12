import { toRemoteKitError, type RemoteKitError } from '../../shared/errors';
import type { FailureContext } from './present';

const operations: Record<string, string> = {
  'tab.navigate': '打开网页',
  'tab.create': '创建标签页',
  'tab.command': '完成页面操作',
  'tab.activate': '切换标签页',
  'tab.close': '关闭标签页',
  'tab.move': '移动标签页',
  'window.open': '打开窗口',
  'window.focus': '切换窗口',
  'window.place': '移动窗口',
  'window.close': '关闭窗口',
  'window.state': '保存查看状态',
  'space.activate': '切换窗口组',
  'space.close': '关闭窗口组',
  'space.weights': '保存分栏比例',
  'favorite.toggle': '保存收藏',
  'favorite.remove': '移除收藏',
  'settings.update': '保存此设置',
  'page.reply': '提交网页回复',
  'page.exitFullscreen': '退出网页全屏',
  'launcher.get': '读取启动器内容',
  'app.inspect': '读取网页信息',
  'app.install': '安装应用',
  'app.update': '保存应用设置',
  'app.uninstall': '卸载应用',
  'usage.clear': '清除使用记录',
  'clipboard.get': '同步共享剪贴板',
  'clipboard.set': '同步剪贴板',
  'announcement.read': '保存公告已读状态',
  'library.get': '读取我的文件',
  'library.import': '导入文件',
  'library.replace': '保存照片',
  'library.basket': '更新文件篮',
  'library.move': '移动文件',
  'library.delete': '删除文件',
  'library.partition': '保存分区',
  'library.partitionDelete': '删除分区',
  'library.source': '保存来源设置',
  'library.sourcePurge': '清空来源文件',
  'library.basketPartition': '保存分区选择',
  'library.snippet': '读取剪贴片段',
  'library.copySnippet': '复制剪贴片段',
  'library.prepare': '准备发送文件',
  'library.finish': '确认文件接收结果',
  'learning.signIn': '登录学习账户',
  'learning.signInCancel': '取消学习账户登录',
  'learning.signOut': '退出学习账户',
  'study.sync': '同步学习资料',
  'study.settings': '保存保留时间',
  'study.subjects': '读取学习科目',
  'study.homework.list': '读取作业列表',
  'study.materials.list': '读取班级资料',
  'study.homework.detail': '读取作业详情',
  'study.attachment.save': '保存附件',
  'bank.subjects': '读取题库科目',
  'bank.subject': '读取科目筛选项',
  'bank.catalog': '读取教材目录',
  'bank.questions': '读取题目',
  'document.progress.get': '读取阅读位置',
  'document.progress.set': '保存阅读位置',
  'diagnostics.start': '开始诊断',
  'diagnostics.sample': '收集诊断样本',
  'diagnostics.stop': '确认诊断保存结果',
  'diagnostics.status': '确认诊断保存结果',
  'admin.overview': '读取管理概览',
  'admin.users': '读取用户列表',
  'admin.storage': '读取存储状态',
  'admin.diagnostics': '读取诊断包列表',
  'admin.announcements': '读取公告列表',
  'admin.createUser': '创建用户',
  'admin.resetPassword': '重置用户密码',
  'admin.clearSecondFactors': '清除用户验证方式',
  'admin.signOut': '使用户退出',
  'admin.hibernate': '休眠用户会话',
  'admin.resetSession': '重置浏览器数据',
  'admin.setDisabled': '更新账户状态',
  'admin.transferAdmin': '转让管理员权限',
  'admin.deleteUser': '删除用户及其数据',
  'admin.publishAnnouncement': '发布公告',
  'admin.updateAnnouncement': '保存公告',
  'admin.deleteAnnouncement': '删除公告',
  'admin.deleteDiagnostic': '删除诊断包',
  'admin.downloadDiagnostic': '下载诊断包',
  'admin.findError': '查找错误记录',
  'admin.sessionImportDeployment': '下载部署配置',
  'sessionImport.state': '读取会话导入状态',
  'sessionImport.pairing': '保存配对设置',
  'sessionImport.removeDevice': '移除设备',
  'sessionImport.discard': '放弃会话导入',
};
const owners = new WeakMap<object, string>();
export function ownOperation<T extends object>(operation: T, ownerKey: string): T {
  owners.set(operation, ownerKey);
  return operation;
}
const contexts = new WeakMap<RemoteKitError, Partial<FailureContext>>();
export function operationFailure(error: unknown, method: string, params?: unknown) {
  const failure = toRemoteKitError(error);
  const values = (params ?? {}) as Record<string, unknown>;
  const targetId = [
    values.entryId,
    values.tabId,
    values.windowId,
    values.id,
    values.key,
    values.username,
  ].find((value) => typeof value === 'string') as string | undefined;
  const operation = operations[method];
  if (operation)
    contexts.set(failure, {
      operation,
      targetId,
      ownerKey: params && typeof params === 'object' ? owners.get(params) : undefined,
    });
  return failure;
}
export function failureContext(error: RemoteKitError) {
  return contexts.get(error);
}
