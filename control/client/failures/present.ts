import { failureContext } from './operations';
import { parseWireError, RemoteKitError, type WireError } from '../../shared/errors';
import { formatError } from '../util/format-error';
import { failureText } from './text';
import { viewerErrors } from './reporting';

export type FailureScope = 'field' | 'item' | 'surface' | 'global' | 'full-screen';
export type CapacityKind =
  'storage' | 'basket' | 'catalog' | 'windows' | 'tabs' | 'site-settings' | 'field' | 'selection' | 'file';
export interface FailureAction {
  label: string;
  run(owner?: HTMLElement): void;
}
export interface FailureContext {
  operation: string;
  scope: FailureScope;
  ownerKey?: string;
  targetId?: string;
  itemName?: string;
  field?: string;
  input?: boolean;
  capacity?: CapacityKind;
  connection?: boolean;
  credential?: 'control' | 'changyan' | 'xinjiaoyu' | 'mailbox';
  issue?: 'permission' | 'credentials' | 'lease' | 'configuration' | 'content' | 'validation';
  consequence?: string;
  text?: string;
  longText?: string;
  action?: FailureAction;
}
export interface Presentation {
  class: 'A' | 'B' | 'C' | 'silent';
  text: string;
  longText?: string;
  action?: FailureAction;
  errorId?: string;
  connection?: boolean;
}

const actionListeners = new Set<(action: string, context: FailureContext) => void>();
export function onFailureAction(listener: (action: string, context: FailureContext) => void) {
  actionListeners.add(listener);
  return () => {
    actionListeners.delete(listener);
  };
}
function action(label: string, kind: string, context: FailureContext): FailureAction {
  return {
    label,
    run: (owner) => {
      const surface = owner?.closest<HTMLElement>('form, [role="dialog"], .window-frame') ?? document.body;
      if (kind === 'edit' || kind === 'selection') {
        const input = surface.querySelector<HTMLElement>(
          'input:not([disabled]):not([type="hidden"]):not([type="file"]),textarea:not([disabled]),[contenteditable="true"]',
        );
        if (input) {
          input.focus();
          return;
        }
      }
      if (kind === 'retake') {
        const control = Array.from(surface.querySelectorAll<HTMLButtonElement>('button')).find((button) =>
          /重拍|摄像头拍照/.test(button.textContent ?? button.getAttribute('aria-label') ?? ''),
        );
        if (control) {
          control.click();
          return;
        }
      }
      if (kind === 'choose-file') {
        const input = surface.querySelector<HTMLInputElement>('input[type="file"]');
        if (input) {
          input.click();
          return;
        }
      }
      if (kind === 'current') {
        surface.scrollIntoView({ block: 'nearest' });
        return;
      }
      if (context.field && typeof document !== 'undefined') {
        const field = document.querySelector<HTMLElement>(context.field);
        if (field) {
          field.focus();
          return;
        }
      }
      actionListeners.forEach((listener) => listener(kind, context));
    },
  };
}

function operationText(context: FailureContext) {
  if (context.operation === '连接浏览器') return failureText.browser;
  if (['连接服务', '恢复工作区连接', '连接验证服务'].includes(context.operation)) return failureText.control;
  if (context.operation === '显示远程视频') return failureText.video;
  if (context.operation === '导入文件' || context.operation === '上传文件') {
    if (!context.itemName) return failureText.upload;
    return [
      `正在上传 ${context.itemName}…`,
      `暂时无法上传 ${context.itemName}，恢复后自动继续`,
      `${context.itemName} 未能导入`,
    ];
  }
  if (context.operation === '下载到我的文件') return failureText.download;
  if (/照片|扫描/.test(context.operation)) return failureText.photo;
  if (context.operation === '打开文档') return failureText.document;
  if (context.operation === '加载此页') return failureText.page;
  if (context.operation === '确认诊断保存结果') return failureText.diagnostic;
  return [
    `正在${context.operation}…`,
    `暂时无法${context.operation}，恢复后自动继续`,
    `未能${context.operation}${context.consequence ? `，${context.consequence}` : ''}`,
  ];
}

const parsedErrors = new WeakMap<object, RemoteKitError>();

export function presentFailure(value: RemoteKitError | WireError, context: FailureContext): Presentation {
  let error = value instanceof RemoteKitError ? value : parsedErrors.get(value);
  if (!error) {
    error = parseWireError(value)!;
    parsedErrors.set(value, error);
  }
  context = { ...context, ...failureContext(error) };
  const texts = operationText(context);
  if (error.reason === 'session_data_on_offline_node')
    return {
      class: 'A',
      text: '会话数据所在节点离线，恢复后自动继续',
      longText: '会话数据所在节点离线，恢复后自动继续',
      connection: true,
    };
  if (error.code === 'canceled') return { class: 'silent', text: '' };
  if (
    context.issue !== 'configuration' &&
    context.issue !== 'lease' &&
    (['busy', 'rate_limited', 'unavailable', 'outcome_unknown'].includes(error.code) ||
      ['browser_restarting', 'browser_crashed', 'output_failed'].includes(error.reason ?? ''))
  )
    return {
      class: 'A',
      text: context.text ?? (error.code === 'outcome_unknown' ? failureText.confirm : texts[0]),
      longText: context.longText ?? texts[1],
      connection: context.connection,
    };
  const user = (text: string, label: string, kind: string): Presentation => ({
    class: 'B',
    text,
    action: context.action ?? action(label, kind, context),
  });
  if (context.issue === 'lease') return user(failureText.lease, '重新加载', 'reload');
  if (context.credential !== 'mailbox' && error.code === 'unauthenticated') {
    if (context.issue === 'credentials') return user(failureText.invalidCredentials, '修改登录信息', 'edit');
    if (context.credential === 'changyan' || context.credential === 'xinjiaoyu') {
      const provider = context.credential === 'changyan' ? '畅言' : '新教育';
      return user(`未能读取学习内容，${provider}登录已过期`, `登录${provider}`, 'provider-login');
    }
    return user(failureText.signIn, '登录', 'sign-in');
  }
  if (error.code === 'locked') return user(failureText.unlock, '解锁', 'unlock');
  if (context.issue === 'permission') return user(failureText.permission, '授权此功能', 'permission');
  if (context.issue === 'credentials' && error.code === 'rejected')
    return user(failureText.rejectedCredentials, '修改登录信息', 'edit');
  if (context.issue === 'credentials' && context.credential !== 'control' && error.code === 'forbidden')
    return user(failureText.invalidPassword, '输入密码', 'edit');
  if (
    (error.code === 'limit_exceeded' && !(context.connection && !error.capacity && !context.capacity)) ||
    ['file_too_large', 'storage_quota_exceeded'].includes(error.reason ?? '')
  ) {
    const capacity =
      error.capacity ??
      context.capacity ??
      (error.reason === 'storage_quota_exceeded'
        ? 'storage'
        : /文件|文档|照片/.test(context.operation)
          ? 'file'
          : context.input
            ? 'field'
            : 'selection');
    const rules: Record<CapacityKind, [string, string, string]> = {
      storage: [failureText.storage, '打开我的文件', 'files'],
      basket: [failureText.capacity.basket, '打开我的文件', 'files'],
      catalog: [failureText.capacity.catalog, '打开我的文件', 'files'],
      windows: [failureText.capacity.windows, '管理窗口', 'windows'],
      tabs: [failureText.capacity.tabs, '管理标签页', 'tabs'],
      'site-settings': [failureText.capacity['site-settings'], '管理网站设置', 'site-settings'],
      field: [failureText.capacity.field, '修改内容', 'edit'],
      selection: [failureText.capacity.selection, '调整所选内容', 'selection'],
      file: [failureText.capacity.file, '换一个文件', 'choose-file'],
    };
    return user(...rules[capacity]);
  }
  if (error.code === 'invalid_request' && context.input)
    return user(context.text ?? failureText.invalidInput, '修改内容', 'edit');
  if (error.code === 'conflict' || error.code === 'not_found')
    return user(
      context.text ?? (error.code === 'not_found' ? failureText.missing : failureText.changed),
      context.action?.label ?? '查看当前内容',
      'current',
    );
  if (error.code === 'rejected' || context.issue === 'content') {
    const reason = error.reason as keyof typeof failureText;
    const reasonText = failureText[reason];
    if (typeof reasonText === 'string' || context.issue === 'content')
      return user(
        context.text ?? (typeof reasonText === 'string' ? reasonText : failureText.unprocessableFile),
        /照片|扫描|拍摄/.test(context.operation) ? '重新拍摄' : '换一个文件',
        /照片|扫描|拍摄/.test(context.operation) ? 'retake' : 'choose-file',
      );
  }
  viewerErrors.identify(error, {
    operation: context.operation,
    scope: context.scope,
    targetId: context.targetId,
    ownerKey: context.ownerKey,
    issue: context.issue,
  });
  return {
    class: 'C',
    text: context.text ?? texts[2] ?? formatError(error),
    errorId: error.errorId,
  };
}
