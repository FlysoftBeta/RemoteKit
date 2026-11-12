import { runtimeConfig } from '../../control/server/config';
import { configureLog, FileLogSink } from '../../control/server/log';
configureLog(new FileLogSink(runtimeConfig().logDir));
await import('./cluster-harness.mts');
