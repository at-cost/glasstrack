import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export class ApiError extends HTTPException {
  constructor(
    status: ContentfulStatusCode,
    readonly code: string,
    message: string,
  ) {
    super(status, { message });
  }
}

export const notFound = (what = "Not found") => new ApiError(404, "not_found", what);
export const forbidden = (msg = "You don't have permission to do that") => new ApiError(403, "forbidden", msg);
export const badRequest = (msg: string, code = "bad_request") => new ApiError(400, code, msg);
export const conflict = (msg: string) => new ApiError(409, "conflict", msg);
export const unauthorized = () => new ApiError(401, "unauthorized", "Please sign in");
