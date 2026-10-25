// The declaration library's surface (@dinfra/fleet-bridge/declare): an optional helper for the
// format in docs/declare.md. An app uses declareAction and refuse, serves over HTTP
// (serveActions with one caller check: agentKeyCallers, bearerCallers or bridgeCallers) or over
// the mesh (serveMeshActions with meshCallers), and sends job results with jobResult.
// Apps declare their schemas with this same zod, so the library's schema checks recognise them
// whatever zod the app itself uses elsewhere.
export { z } from 'zod';
export { readBody } from './body.ts';
export { pinnedFetchOptions } from './pin.ts';
export type { PinnedFetchOptions } from './pin.ts';
export { declareAction, refuse, serveActions, actionCore, declaration, checkVia, ROUTE_PREFIX, MAX_BODY_BYTES, STANDARD_CODES } from './actions.ts';
export type { Action, Call, CoreOptions, Refusal, ServeOptions, Verdict, Via, Who } from './actions.ts';
export { serveMeshActions, meshCallers, meshIdentity, jobResult } from './mesh.ts';
export { DeclarationFormat, AnswerFormat, MeshRequestFormat, MeshReplyFormat, JobMessageFormat, ViaFormat } from './format.ts';
export type { MeshDelivery, MeshServeOptions } from './mesh.ts';
export { bridgeCallers, bearerCallers } from './callers.ts';
export type { CallerCheck, CallerRequest, CallerResult } from './callers.ts';
export {
  agentKeyCallers,
  agentKeyMessage,
  staticKeySource,
  listKeySource,
  holdersOf,
  NonceBook,
  AGENT_KEY_NAMESPACE,
  AGENT_KEY_HEADERS,
  AGENT_KEY_WINDOW_MS,
} from './agent-key.ts';
export type { KeyHolder, KeySource } from './agent-key.ts';
export { verifySshsig, blobFromPublicKeyLine, ed25519FromBlob, fingerprintOf } from './sshsig.ts';
export { memoryRepeats, inputSha256, ID_RE } from './repeats.ts';
export type { Answer, Remembered, RepeatStore } from './repeats.ts';
export {
  signVouch,
  verifyVouch,
  vouchMessage,
  bridgeKeyText,
  parseBridgeKey,
  sha256Hex,
  isActionName,
  NonceCache,
  VOUCH_NAMESPACE,
  VOUCH_HEADER,
  CALLER_HEADER,
  VOUCH_WINDOW_MS,
  DECLARATION_ACTION,
  SYSTEM_RE,
  ACTION_RE,
  CALLER_RE,
} from './vouch.ts';
export type { VouchFields, VouchResult } from './vouch.ts';
