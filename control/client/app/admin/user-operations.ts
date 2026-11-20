import type { AdminSocketMethods, AdminUser } from '../../../shared/admin';

export type UserMethod = {
  [K in keyof AdminSocketMethods]: AdminSocketMethods[K]['result'] extends AdminUser[] ? K : never;
}[keyof AdminSocketMethods];

export function projectUsers(
  users: AdminUser[],
  method: UserMethod,
  params: Record<string, unknown>,
  self: string,
): AdminUser[] {
  if (method === 'admin.deleteUser') return users.filter((user) => user.username !== params.username);
  if (method === 'admin.createUser')
    return users.some((user) => user.username === params.username)
      ? users
      : [
          ...users,
          {
            username: params.username as string,
            isAdmin: false,
            disabled: false,
            online: false,
            lastLoginAt: null,
            session: { state: 'none', boundNodeId: null },
            secondFactors: { pin: false, face: false },
            storage: { bytes: 0, quotaBytes: null },
          },
        ];
  return users.map((original) => {
    if (method === 'admin.transferAdmin')
      return { ...original, isAdmin: original.username === params.username };
    if (original.username !== params.username) return original;
    const user = JSON.parse(JSON.stringify(original)) as AdminUser;
    switch (method) {
      case 'admin.setDisabled':
        user.disabled = params.disabled as boolean;
        if (user.disabled) user.online = false;
        break;
      case 'admin.signOut':
        user.online = false;
        break;
      case 'admin.resetPassword':
        if (user.username !== self) user.online = false;
        break;
      case 'admin.clearSecondFactors':
        user.secondFactors = { pin: false, face: false };
        if (user.username !== self) user.online = false;
        break;
      case 'admin.stop':
        if (user.session.state !== 'none') user.session.state = 'stopped';
        break;
      case 'admin.resetSession':
        user.session = { state: 'none', boundNodeId: user.session.boundNodeId };
        break;
      case 'admin.transfer':
        user.session.boundNodeId = params.bind ? (params.nodeId as string) : null;
        if (user.session.state !== 'none' && params.nodeId) {
          user.session.nodeId = params.nodeId as string;
          user.session.nodeOffline = false;
        }
        break;
    }
    return user;
  });
}
