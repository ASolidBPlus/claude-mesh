export { MeshClient } from './client.ts';
export type {
  MeshClientConfig,
  MeshClientEvent,
  SendOpts,
  PublishOpts,
  SendFileOpts,
  Inbound,
  Reminder,
  PresenceEntry,
} from './client.ts';
export * from './protocol.ts'; // all wire types + MeshKind for external consumers
