// SPDX-License-Identifier: Apache-2.0

export { type ApiError, type ApiResult, apiOk, apiErr } from "./result.js";
export { LoomwikiError, type LoomwikiErrorOptions, isLoomwikiError } from "./error.js";
export { ErrorCodes, type ErrorCode } from "./errors.js";
export { id } from "./id.js";
export {
  PROTOCOL_VERSION,
  MAX_BODY_CHARS,
  WireMessageSchema,
  type WireMessage,
  ClientMsgSchema,
  type ClientMsg,
  ServerMsgSchema,
  type ServerMsg,
} from "./ws-protocol.js";
export {
  renderMarkdown,
  defaultSanitizeSchema,
  createMarkdownAstParser,
} from "./markdown-sanitize.js";
export { chunkPageBySection, slugifyHeading, type WikiChunk } from "./markdown-chunk.js";
