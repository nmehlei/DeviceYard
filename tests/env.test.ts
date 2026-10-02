import {
  isSecretKey, parseEnvField, maskEnvForStorage, maskSecrets, EnvValidationError, REDACTED,
} from "../src/env";

describe("isSecretKey", () => {
  it.each(["E2E_TEST_PASSWORD", "api_key", "MY_TOKEN", "SECRET_THING", "AwS_Api_Key", "APIKEY", "MY_APIKEY", "apikey"])(
    "treats %s as secret", (k) => expect(isSecretKey(k)).toBe(true));

  // The values a caller genuinely needs to see in artifacts when debugging
  // a divergent run.
  it.each(["E2E_TEST_USER", "E2E_LAUNCHER", "BASE_URL"])(
    "treats %s as not secret", (k) => expect(isSecretKey(k)).toBe(false));

  it("distinguishes both API_KEY (underscore) and APIKEY (no underscore) as secret", () => {
    // Regression check: both spellings must be treated as secret
    expect(isSecretKey("API_KEY")).toBe(true);
    expect(isSecretKey("MY_API_KEY")).toBe(true);
    expect(isSecretKey("APIKEY")).toBe(true);
    expect(isSecretKey("MY_APIKEY")).toBe(true);
  });
});

describe("parseEnvField", () => {
  it("returns undefined when the field is absent - absent is not empty", () => {
    expect(parseEnvField(undefined)).toBeUndefined();
  });

  it("returns undefined when raw is null", () => {
    expect(parseEnvField(null)).toBeUndefined();
  });

  it("returns undefined when raw is empty string", () => {
    expect(parseEnvField("")).toBeUndefined();
  });

  it("parses a flat object", () => {
    expect(parseEnvField('{"A":"1","B":"2"}')).toEqual({ A: "1", B: "2" });
  });

  it("accepts an explicitly empty object, distinct from absent", () => {
    expect(parseEnvField("{}")).toEqual({});
  });

  it.each([
    ["not json", "{oops"],
    ["an array", '["A=1"]'],
    ["a scalar", '"hello"'],
    ["a non-string value", '{"A":1}'],
    ["a nested object", '{"A":{"B":"1"}}'],
  ])("rejects %s", (_label, raw) => {
    expect(() => parseEnvField(raw)).toThrow(EnvValidationError);
  });

  it.each(["1BAD", "has space", "has-dash", "has=equals", ""])(
    "rejects the invalid key %p and names it in the message", (key) => {
      try {
        parseEnvField(JSON.stringify({ [key]: "v" }));
        throw new Error("expected a throw");
      } catch (err) {
        expect(err).toBeInstanceOf(EnvValidationError);
        // A future CLI surfaces this verbatim, so it must name the key.
        expect(String(err)).toContain(key === "" ? "env key" : key);
      }
    });

  it("rejects a newline or NUL in a value", () => {
    expect(() => parseEnvField('{"A":"line\\nbreak"}')).toThrow(EnvValidationError);
    expect(() => parseEnvField('{"A":"nul\\u0000here"}')).toThrow(EnvValidationError);
  });

  it("rejects a carriage return in a value", () => {
    expect(() => parseEnvField('{"A":"line\\rbreak"}')).toThrow(EnvValidationError);
  });

  it("rejects a short SECRET value, which would mask everything", () => {
    expect(() => parseEnvField('{"MY_TOKEN":"ab"}')).toThrow(/MY_TOKEN/);
  });

  it("allows a short NON-secret value", () => {
    expect(parseEnvField('{"E2E_LAUNCHER":"a"}')).toEqual({ E2E_LAUNCHER: "a" });
  });

  it("survives __proto__ as an ordinary key, not via prototype pollution", () => {
    const result = parseEnvField('{"__proto__":"somevalue"}');
    expect(result?.["__proto__"]).toBe("somevalue");
    // Verify it's a real property, not on the prototype chain
    expect(Object.prototype.isPrototypeOf(result as any)).toBe(false);
  });
});

describe("maskEnvForStorage", () => {
  it("keeps non-secret values and redacts secret ones", () => {
    expect(maskEnvForStorage({ E2E_LAUNCHER: "samsung", E2E_TEST_PASSWORD: "hunter2222" }))
      .toEqual({ E2E_LAUNCHER: "samsung", E2E_TEST_PASSWORD: REDACTED });
  });

  it("survives __proto__ as an ordinary key", () => {
    // Create an object with __proto__ as a real property, not via the property shorthand
    const input = Object.create(null);
    input["__proto__"] = "somevalue";
    input.E2E_LAUNCHER = "samsung";
    const result = maskEnvForStorage(input);
    expect(result?.["__proto__"]).toBe("somevalue");
    expect(result?.E2E_LAUNCHER).toBe("samsung");
  });
});

describe("maskSecrets", () => {
  const env = { E2E_LAUNCHER: "samsung", E2E_TEST_PASSWORD: "hunter2222" };

  it("returns text unchanged when there is no env", () => {
    expect(maskSecrets("hunter2222", undefined)).toBe("hunter2222");
  });

  it("returns text unchanged when no key is secret", () => {
    expect(maskSecrets("samsung", { E2E_LAUNCHER: "samsung" })).toBe("samsung");
  });

  it("redacts every occurrence of a secret value", () => {
    expect(maskSecrets("a hunter2222 b hunter2222", env)).toBe(`a ${REDACTED} b ${REDACTED}`);
  });

  it("leaves non-secret values intact - they are what you debug with", () => {
    expect(maskSecrets("launcher=samsung", env)).toContain("samsung");
  });

  // The reason this function exists: Maestro writes -e values into
  // commands-*.json (mobile-dev-inc/Maestro#2512), where a value containing
  // a quote or backslash appears ESCAPED. A literal match walks past it.
  it("redacts the JSON-escaped form of a value too", () => {
    const tricky = { API_KEY: 'pa"ss\\word' };
    const insideJson = JSON.stringify({ env: { API_KEY: 'pa"ss\\word' } });
    expect(insideJson).toContain('pa\\"ss\\\\word');
    const masked = maskSecrets(insideJson, tricky);
    expect(masked).not.toContain('pa\\"ss\\\\word');
    expect(masked).toContain(REDACTED);
  });

  it("still redacts the raw form of a value needing no escaping", () => {
    expect(maskSecrets("hunter2222", env)).toBe(REDACTED);
  });

  // Order-independence: if one secret value is a substring of another, the
  // longer one must not be left half-masked regardless of which key the
  // caller happened to list first (Object.entries iterates in caller-supplied
  // key order). Verified against the unfixed code: with
  // {A_TOKEN:"hunter", B_TOKEN:"hunter2222"} in that order, the shorter
  // "hunter" is replaced first, leaving "***REDACTED***2222" - a live suffix
  // of the real credential - in the output.
  it("fully redacts a longer secret whose value contains a shorter secret's value, key order A-then-B", () => {
    const overlapping = { A_TOKEN: "hunter", B_TOKEN: "hunter2222" };
    const masked = maskSecrets("log: hunter2222 done", overlapping);
    expect(masked).toBe(`log: ${REDACTED} done`);
    expect(masked).not.toContain("2222");
  });

  it("fully redacts a longer secret whose value contains a shorter secret's value, key order B-then-A", () => {
    const overlapping = { B_TOKEN: "hunter2222", A_TOKEN: "hunter" };
    const masked = maskSecrets("log: hunter2222 done", overlapping);
    expect(masked).toBe(`log: ${REDACTED} done`);
    expect(masked).not.toContain("2222");
  });

  // classify() maps .xml to "hierarchy", which IS masked - so a secret typed
  // into a field can land entity-escaped inside an XML hierarchy dump. A
  // literal or JSON-escaped match walks straight past `&amp;`/`&lt;`.
  it("redacts the XML-entity-escaped form of a value containing & and <", () => {
    const tricky = { API_KEY: "a&b<c" };
    const xmlText = `<node text="a&amp;b&lt;c" />`;
    const masked = maskSecrets(xmlText, tricky);
    expect(masked).not.toContain("a&amp;b&lt;c");
    expect(masked).toContain(REDACTED);
  });
});
