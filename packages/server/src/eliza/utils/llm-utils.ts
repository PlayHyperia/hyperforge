import { parseOneJsonObject } from "../promptSafety.js";

export function parseLlmJsonResponse<T>(response: unknown): T | null {
  return parseOneJsonObject(response) as T | null;
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
