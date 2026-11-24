import assert from "node:assert/strict";
import { test } from "node:test";
import { cookieValid, failureLimiter, missingSecrets, sessionToken } from "../src/auth.js";

test("cookie matches only the token for this secret and password", () => {
  const token = sessionToken("s3cret", "pw");
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.ok(cookieValid(`a=1; banchina=${token}; b=2`, token));
  assert.ok(!cookieValid("banchina=deadbeef", token));
  assert.ok(!cookieValid("", token));
  assert.ok(!cookieValid(undefined, token));
});

test("rotating the secret or the password invalidates old cookies", () => {
  const old = sessionToken("s1", "pw");
  assert.ok(!cookieValid(`banchina=${old}`, sessionToken("s2", "pw")));
  assert.ok(!cookieValid(`banchina=${old}`, sessionToken("s1", "pw2")));
  assert.equal(old, sessionToken("s1", "pw"));
});

test("secrets are required only in production", () => {
  assert.deepEqual(missingSecrets({}), []);
  assert.deepEqual(missingSecrets({ FLY_APP_NAME: "a" }), ["ACCESS_PASSWORD", "SESSION_SECRET"]);
  assert.deepEqual(missingSecrets({ NODE_ENV: "production", ACCESS_PASSWORD: "x" }), ["SESSION_SECRET"]);
  assert.deepEqual(missingSecrets({ FLY_APP_NAME: "a", ACCESS_PASSWORD: "x", SESSION_SECRET: "y" }), []);
});

test("limiter blocks after max failures, per IP, until the window passes", () => {
  const limiter = failureLimiter({ max: 3, windowMs: 1000 });
  for (let i = 0; i < 3; i += 1) {
    assert.ok(!limiter.blocked("a", 0));
    limiter.fail("a", 0);
  }
  assert.ok(limiter.blocked("a", 500));
  assert.ok(!limiter.blocked("b", 500));
  assert.ok(!limiter.blocked("a", 1000));
  limiter.fail("a", 1000);
  limiter.reset("a");
  assert.ok(!limiter.blocked("a", 1000));
});

test("limiter map stays bounded", () => {
  const limiter = failureLimiter({ max: 1, windowMs: 1000, maxKeys: 5 });
  for (let i = 0; i < 50; i += 1) limiter.fail(`ip${i}`, i);
  assert.equal(limiter.size, 5);
  assert.ok(limiter.blocked("ip49", 49));
  limiter.fail("late", 5000); // all others expired: swept
  assert.equal(limiter.size, 1);
});
