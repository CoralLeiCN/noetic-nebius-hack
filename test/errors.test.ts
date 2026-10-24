import { test } from "node:test";
import assert from "node:assert/strict";
import { DebateError, publicError } from "../src/errors.js";

const privateDetail = " secret-for-test https://user:pass@example.com/private";

test("provider failures give actionable messages without forwarding private diagnostics", () => {
  const cases: [string, RegExp][] = [
    ["HTTP 500", /temporarily unavailable/],
    ["HTTP 502 Bad Gateway", /temporarily unavailable/],
    ["HTTP 503", /temporarily unavailable/],
    ["HTTP 504", /temporarily unavailable/],
    ["ECONNRESET", /connection to the provider was interrupted/],
    ["ENOTFOUND", /connection to the provider was interrupted/],
    ["fetch failed", /connection to the provider was interrupted/],
    ["stream disconnected before completion", /connection to the provider was interrupted/],
    ["HTTP 429 insufficient_quota", /quota or credits are exhausted/],
    ["insufficient credits", /quota or credits are exhausted/],
    ["billing_hard_limit_reached", /quota or credits are exhausted/],
    ["HTTP 400 context_length_exceeded", /model's input limit/],
    ["maximum context length is 4096", /model's input limit/],
    ["too many input tokens", /model's input limit/],
  ];
  for (const [diagnostic, expected] of cases) {
    const message = publicError(new Error(diagnostic + privateDetail));
    assert.match(message, expected, diagnostic);
    assert.doesNotMatch(message, /secret-for-test|user:pass|https:\/\//);
  }
});

test("specific provider failures preserve authentication and rate-limit guidance", () => {
  assert.match(publicError(new Error("401 insufficient_quota")), /authentication failed/);
  assert.match(publicError(new Error("429 rate limit reached")), /rate limit reached/);
  assert.match(publicError(new Error("404 unsupported endpoint")), /Responses compatibility/);
  assert.match(publicError(new Error("request timed out")), /timed out/);
  assert.match(publicError(new Error("unrecognized diagnostic")), /Generation failed/);
  assert.match(publicError({ message: "503 private response body" }), /Generation failed/);
  assert.equal(publicError(new DebateError("Application-owned guidance.")), "Application-owned guidance.");
});
