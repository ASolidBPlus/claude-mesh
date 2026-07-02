export { MeshClient } from './client.ts';
export type {
  MeshClientConfig,
  MeshClientEvent,
  SendOpts,
  SendFileOpts,
  RequestOpts,
  Inbound,
  Reminder,
  PresenceEntry,
} from './client.ts';
export * from './protocol.ts'; // all wire types + MeshKind for external consumers
