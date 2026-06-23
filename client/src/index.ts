export { MeshClient } from './client.ts';
export type {
  MeshClientConfig,
  MeshClientEvent,
  SendOpts,
  RequestOpts,
  Inbound,
  Reminder,
} from './client.ts';
export * from './protocol.ts'; // all wire types + MeshKind for external consumers
