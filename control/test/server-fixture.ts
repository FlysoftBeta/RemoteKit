import { EndpointGateway } from '../server/endpoint/gateway';
import type { EndpointLink, EndpointLinkState } from '../server/endpoint/link';
import type { Clock } from '../server/util/clock';
export function testGateway(
  link: Pick<EndpointLink, 'request' | 'onSignal' | 'onClientAction'> & { state?: EndpointLinkState },
): EndpointGateway {
  return new EndpointGateway({
    get state() {
      return link.state ?? { state: 'ready', incarnation: 'fixture', connectionEpoch: 'fixture' };
    },
    request: (method, tenant, args) => link.request(method, tenant, args),
    onSignal: link.onSignal?.bind(link),
    onClientAction: link.onClientAction?.bind(link),
  });
}
export class TestClock implements Clock {
  private monotonic = 0;
  private wall = 1800000000000;
  monotonicMs() {
    return this.monotonic;
  }
  wallMs() {
    return this.wall;
  }
  advance(ms: number) {
    this.monotonic += ms;
    this.wall += ms;
  }
}
