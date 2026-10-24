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
  if (/insufficient[_ -]quota|quota[_ -]exceeded|exceeded.{0,30}quota|insufficient.{0,30}(credits|balance)|credits.{0,30}(exhausted|depleted)|billing[_ -](limit|hard_limit)/i.test(text)) {
    return "Provider account quota or credits are exhausted. Check the provider account before retrying.";
  }
  if (/\b429\b|rate.limit/i.test(text)) return "Provider rate limit reached. Wait before retrying.";
  if (/context[_ -](length|window).{0,40}(exceed|limit|long)|maximum context length|context_length_exceeded|too many (input )?tokens|input.{0,20}token.{0,20}limit/i.test(text)) {
    return "The debate exceeds the model's input limit. Start a new debate with a shorter topic or argument.";
  }
  if (/\b(400|404|405|422)\b|unsupported|not.supported/i.test(text)) {
    return "Provider rejected the request. Check the base URL, model, and Codex Responses compatibility.";
  }
  if (/\b(500|502|503|504)\b|service[_ -]unavailable|bad gateway|internal server error/i.test(text)) {
    return "The provider is temporarily unavailable. Wait a moment, then retry the generation.";
  }
  if (/timeout|timed.out/i.test(text)) return "Generation timed out. Retry or start a new session.";
  if (/ENOENT|executable|spawn|Codex CLI binaries/i.test(text)) return "Codex could not start. Reinstall dependencies with npm ci, including optional dependencies.";
  if (/\b(ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE)\b|fetch failed|connection (reset|refused|closed)|stream (disconnected|interrupted)|stream disconnected before completion/i.test(text)) {
    return "The connection to the provider was interrupted. Check connectivity, then retry the generation.";
  }
  return "Generation failed. Check provider availability and configuration, then retry.";
}
