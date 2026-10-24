export class DebateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DebateError";
  }
}

// Provider errors may contain response bodies, URLs, or credentials. Classify
// them internally and expose only messages owned by this application.
export function publicError(error: unknown): string {
  if (error instanceof DebateError) return error.message;
  const text = error instanceof Error ? error.message : "";
  if (/\b(401|403)\b|unauthorized|invalid.api.key/i.test(text)) {
    return "Provider authentication failed. Check NEBIUS_API_KEY and endpoint access.";
  }
  if (/\b429\b|rate.limit/i.test(text)) return "Provider rate limit reached. Wait before retrying.";
  if (/\b(400|404|405|422)\b|unsupported|not.supported/i.test(text)) {
    return "Provider rejected the request. Check the base URL, model, and Codex Responses compatibility.";
  }
  if (/timeout|timed.out/i.test(text)) return "Generation timed out. Retry or start a new session.";
  if (/ENOENT|executable|spawn/i.test(text)) return "Codex could not start. Reinstall dependencies with npm ci.";
  return "Generation failed. Check provider availability and configuration, then retry.";
}
