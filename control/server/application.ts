import type { Control } from './control';
import type { ControlDatabase } from './persistence/database';
import type { LocalProcessLink } from './endpoint/local-process';
import type { RemoteNodeLink } from './endpoint/remote-node';
import type { createHttp } from './http';
import type { RuntimeConfig } from './config';
export function startApplication(
  config: RuntimeConfig,
  store: ControlDatabase,
  link: LocalProcessLink | RemoteNodeLink,
  control: Control,
  server: ReturnType<typeof createHttp>,
) {
  let closing = false;
  const background = new Set<Promise<unknown>>();
  function run(work: Promise<unknown>) {
    background.add(work);
    void work.then(
      () => background.delete(work),
      (error) => {
        background.delete(work);
        console.error(error);
      },
    );
  }
  const endpointReady = (identity?: { processChanged: boolean }) => {
    if (!closing) run(control.endpointReady(identity));
  };
  link.on('ready', endpointReady);
  const endpointOffline = () => {
    if (!closing) control.endpointOffline();
  };
  link.on('offline', endpointOffline);
  const reconciliationTimer = setInterval(() => {
    if (!closing) run(control.tick());
  }, 1500);
  server.listen(config.port, config.host, () => {
    link.start();
    const address = server.address();
    console.log(
      `RemoteKit Control ${config.tls ? 'https' : 'http'}://${config.host}:${typeof address === 'object' ? address?.port : config.port}`,
    );
  });
  let closePromise: Promise<void> | undefined;
  function close(): Promise<void> {
    if (closePromise) return closePromise;
    closing = true;
    clearInterval(reconciliationTimer);
    link.off('ready', endpointReady);
    link.off('offline', endpointOffline);
    closePromise = (async () => {
      await server.shutdown();
      while (background.size) await Promise.allSettled([...background]);
      await control.close();
      await link.stop();
      store.db.close();
    })();
    return closePromise;
  }
  process.on('SIGINT', () => {
    void close();
  });
  process.on('SIGTERM', () => {
    void close();
  });
  process.once('disconnect', () => {
    void close();
  });
}
