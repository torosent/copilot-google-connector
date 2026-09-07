import { ConnectorError } from "../core/errors.js";
import { MAX_RESPONSE_BYTES } from "./constants.js";

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface JsonResponse {
  status: number;
  headers: Headers;
  body: unknown;
}

export async function fetchJson(
  fetcher: Fetch,
  url: string,
  init: RequestInit,
  options: { maxBytes?: number; timeoutMs?: number; mutation?: boolean } = {},
): Promise<JsonResponse> {
  const limit = options.maxBytes ?? MAX_RESPONSE_BYTES;
  const controller = new AbortController();
  let httpStatus: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new ConnectorError("request_timeout", "Google did not finish responding before the request deadline.", !options.mutation, { outcomeUnknown: options.mutation === true }));
    }, options.timeoutMs ?? 20_000);
  });
  try {
    return await Promise.race([
      (async () => {
        const response = await fetcher(url, { ...init, redirect: "error", signal: controller.signal });
        httpStatus = response.status;
        const length = response.headers.get("content-length");
        if (length !== null && (!/^\d+$/.test(length) || Number(length) > limit)) {
          await response.body?.cancel();
          throw new ConnectorError("response_too_large", "Google returned a response larger than the configured byte limit.");
        }
        const chunks: Uint8Array[] = [];
        let size = 0;
        if (response.body) {
          const reader = response.body.getReader();
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              size += value.byteLength;
              if (size > limit) {
                await reader.cancel();
                throw new ConnectorError("response_too_large", "Google returned a response larger than the configured byte limit.");
              }
              chunks.push(value);
            }
          } finally {
            reader.releaseLock();
          }
        }
        let body: unknown = undefined;
        if (size > 0) {
          try {
            body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          } catch {
            if (response.status >= 200 && response.status < 300) {
              throw new ConnectorError("invalid_google_response", "Google returned an invalid JSON response.");
            }
          }
        } else if (response.status >= 200 && response.status < 300 && response.status !== 204) {
          throw new ConnectorError("invalid_google_response", "Google returned an empty response where JSON was required.");
        }
        return { status: response.status, headers: response.headers, body };
      })(),
      timeout,
    ]);
  } catch (error) {
    if (options.mutation && httpStatus !== undefined && httpStatus >= 400 && httpStatus < 500 && httpStatus !== 408) {
      throw new ConnectorError("google_request_failed", "Google rejected the request; its error response could not be read safely.", false, { httpStatus, outcomeUnknown: false });
    }
    if (error instanceof ConnectorError) {
      throw new ConnectorError(error.code, error.message, !options.mutation && error.retryable, {
        ...error.details, ...(httpStatus !== undefined ? { httpStatus } : {}), outcomeUnknown: options.mutation === true,
      });
    }
    throw new ConnectorError("google_network_error", "The Google request did not complete.", !options.mutation, {
      ...(httpStatus !== undefined ? { httpStatus } : {}), outcomeUnknown: options.mutation === true,
    });
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

export function retryDelay(headers: Headers, attempt: number, now = Date.now()): number {
  const value = headers.get("retry-after");
  if (value !== null) {
    const milliseconds = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now;
    if (Number.isFinite(milliseconds)) return Math.max(0, Math.min(milliseconds, 3000));
  }
  return Math.min(250 * 2 ** attempt, 2000);
}

export const sleep = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));
