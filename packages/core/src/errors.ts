import { AxiError, exitCodeForError as sdkExitCode } from "axi-sdk-js";
import { redactSecrets } from "./secrets.js";
import { tool } from "./tool.js";

export { AxiError };

export type ErrorCode =
  | "VALIDATION_ERROR"
  | "READ_ONLY"
  | "AUTH_REQUIRED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "NETWORK"
  | "TIMEOUT"
  | "QUERY_ERROR"
  | "WRITE_ERROR"
  | "SETUP_FAILED"
  | "UNKNOWN";

export function usageError(message: string, suggestions: string[] = []): AxiError {
  return new AxiError(message, "VALIDATION_ERROR", suggestions);
}

export function axiError(message: string, code: ErrorCode, suggestions: string[] = []): AxiError {
  return new AxiError(message, code, suggestions);
}

/** Input refused by the read-only guard is a usage error too: exit 2. */
export function exitCodeForError(error: unknown): number {
  return error instanceof AxiError && error.code === "READ_ONLY" ? 2 : sdkExitCode(error);
}

interface DriverError {
  name?: string;
  code?: number | string;
  codeName?: string;
  message?: string;
  errorResponse?: { errmsg?: string };
  cause?: unknown;
  reason?: { servers?: Map<string, { error?: { message?: string } }> };
}

const NETWORK_CAUSES: Array<[RegExp, string]> = [
  [/ECONNREFUSED/, "connection refused"],
  [/ENOTFOUND|EAI_AGAIN|querySrv/, "host not found"],
  [/ETIMEDOUT|timed out/i, "timed out"],
  [/certificate|SSL|TLS/i, "TLS handshake failed"],
];

/** The first connection problem the server selection saw, as a short phrase. */
function networkCause(e: DriverError): string {
  const texts = [e.message ?? ""];
  for (const server of e.reason?.servers?.values() ?? []) texts.push(server.error?.message ?? "");
  const text = texts.join(" ");
  return NETWORK_CAUSES.find(([pattern]) => pattern.test(text))?.[1] ?? "no reachable server";
}

/** Map a driver error to an AxiError. Never echoes connection secrets. */
export function fromDriverError(error: unknown, where: string): AxiError {
  if (error instanceof AxiError) return error;
  const e = (error ?? {}) as DriverError;
  const message = redactSecrets(e.errorResponse?.errmsg ?? e.message ?? String(error));
  if (e.name === "MongoServerSelectionError" || e.name === "MongoTopologyClosedError") {
    return axiError(`cannot reach ${where} - ${networkCause(e)}`, "NETWORK", ["Is the server running? Check `docker ps` or the host/port of the profile"]);
  }
  if (e.name === "MongoNetworkError" || e.name === "MongoNetworkTimeoutError") return axiError(`connection to ${where} failed - ${message}`, "NETWORK");
  if (e.name === "MongoParseError" || e.name === "MongoInvalidArgumentError") return usageError(message);
  const server = e.codeName ? ` (${e.codeName})` : "";
  switch (e.code) {
    case 18:
      return axiError(`authentication failed for ${where}`, "AUTH_REQUIRED", ["Check the user, password and auth source of the profile (`auth status`)"]);
    case 13:
      // 3.x says "no users authenticated", 4.x+ "requires authentication": no credentials, not a missing role.
      if (/no users authenticated|requires authentication/i.test(message)) {
        return axiError(`${where} requires authentication`, "AUTH_REQUIRED", [
          `Log in with a user: printf %s "$DB_PASSWORD" | ${tool().name} auth login --profile <name> ... --user <user> --password-stdin`,
        ]);
      }
      return axiError(`${message}${server}`, "FORBIDDEN", ["The account lacks this privilege - `doctor` lists its roles"]);
    case 50:
      return axiError("the query exceeded the time limit", "TIMEOUT", [
        "Check the plan with `explain` and narrow the filter to an indexed field",
        "Raise --timeout <seconds> only on a database you own - a long scan loads a shared server",
      ]);
    case 26:
      return axiError(`${message}${server}`, "NOT_FOUND");
    case 11000:
    case 121:
      return axiError(`${message}${server}`, "WRITE_ERROR");
  }
  if (typeof e.code === "number") return axiError(`${message}${server}`, "QUERY_ERROR");
  return axiError(message, "UNKNOWN");
}
