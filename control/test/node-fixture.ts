import { createHash } from 'node:crypto';
import { mediaDefaults, limitDefaults, type ConfiguredNode } from '../server/config';
import { publicKey } from '../server/cluster/noise';
export const endpointDefaults = {
  media: mediaDefaults,
  peer: { listen: '127.0.0.1:3101', address: '127.0.0.1:3101' },
  rtc: { ports: null, address: null },
};
export const nodePrivateKey = (node: string) =>
  createHash('sha256')
    .update('test node ' + node)
    .digest();
export function testNode(nodeId: string): ConfiguredNode {
  return {
    config: { ...endpointDefaults, nodeId },
    configHash: nodeId,
    limits: { ...limitDefaults },
    bootstrapFile: 'fixture/node.json',
    remote: { control: 'ws://127.0.0.1/api/node' },
    publicKey: publicKey(nodePrivateKey(nodeId)).toString('base64'),
  };
}
