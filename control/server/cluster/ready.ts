import type { ParsedNode } from '../config';
import { MAX_HANDSHAKE_PAYLOAD } from './noise';

export interface NodePeer {
  nodeId: string;
  address: string;
  publicKey: string;
}
export interface ObjectKeys {
  objectKey: string;
  objectIdKey: string;
}
export function encodeNodeReady(
  node: ParsedNode,
  peers: readonly NodePeer[],
  buildId: string,
  connectionEpoch: string,
  objectKeys?: ObjectKeys,
) {
  return Buffer.from(
    JSON.stringify({
      type: 'node.ready',
      peers,
      ...objectKeys,
      connectionEpoch,
      buildId,
      config: node.config,
      configHash: node.configHash,
    }),
  );
}

export function validateNodeReadySizes(nodes: Readonly<Record<string, ParsedNode>>, buildId: string) {
  const publicKey = Buffer.alloc(32).toString('base64');
  const peers = Object.entries(nodes).map(([nodeId, node]) => ({
    nodeId,
    address: node.config.peer.address,
    publicKey,
  }));
  for (const [nodeId, node] of Object.entries(nodes)) {
    const bytes = encodeNodeReady(
      node,
      peers.filter((peer) => peer.nodeId !== nodeId),
      buildId,
      '00000000-0000-0000-0000-000000000000',
      { objectKey: publicKey, objectIdKey: publicKey },
    ).length;
    if (bytes > MAX_HANDSHAKE_PAYLOAD)
      throw new Error(
        `nodes.${nodeId} node.ready is ${bytes} bytes; limits.handshakeBytes allows ${MAX_HANDSHAKE_PAYLOAD} payload bytes`,
      );
  }
}
