import { useEffect, useRef, useState } from 'react';
import { RemoteKitError } from '../../shared/errors';
import type { ProductUser } from '../../shared/product';
import { request } from '../control/http-request';
import { failureError } from '../failures';
import { recover, recoverRead } from '../failures/recovery';

export function useIdentitySession() {
  const [user, setUser] = useState<ProductUser | null | undefined>();
  const [notice, setNotice] = useState<RemoteKitError>();
  const [connectionError, setConnectionError] = useState<RemoteKitError>();
  const [input, setInput] = useState(0);
  const lifetime = useRef(new AbortController());
  useEffect(() => () => lifetime.current.abort(), []);
  useEffect(() => {
    const abort = new AbortController();
    void recoverRead(
      () => request<{ user: ProductUser }>('/api/auth/me'),
      abort.signal,
      setConnectionError,
    ).then(
      (result) => {
        setConnectionError(undefined);
        setUser(result.user);
      },
      (error) => {
        if (error.code === 'unauthenticated') {
          setConnectionError(undefined);
          setUser(null);
        }
      },
    );
    return () => abort.abort();
  }, [input]);
  const logout = () => {
    setUser(null);
    void recover(() => request('/api/auth/logout', {}), lifetime.current.signal, setNotice).then(
      () => setNotice(undefined),
      (error) => setNotice(failureError(error)),
    );
  };
  return {
    user,
    setUser,
    notice,
    setNotice,
    connectionError,
    logout,
    retry: () => setInput((value) => value + 1),
  };
}
