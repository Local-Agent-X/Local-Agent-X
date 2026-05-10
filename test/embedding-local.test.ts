import { describe, it, expect } from "vitest";
import { LocalEmbeddings } from "../src/embedding-providers/local.js";

describe("LocalEmbeddings — shape", () => {
  it("has the expected interface fields", () => {
    const e = new LocalEmbeddings();
    expect(e.name).toBe("local");
    expect(e.dimensions).toBe(256);
    expect(e.model).toBe("tfidf-256");
  });

  it("returns a 256-dim vector for any non-empty input", async () => {
    const e = new LocalEmbeddings();
    const v = await e.embed("hello world");
    expect(v).toHaveLength(256);
  });

  it("returns the zero vector for empty / whitespace input", async () => {
    const e = new LocalEmbeddings();
    const v1 = await e.embed("");
    const v2 = await e.embed("   ");
    expect(v1.every(x => x === 0)).toBe(true);
    expect(v2.every(x => x === 0)).toBe(true);
  });

  it("returns the zero vector when tokens are filtered out by length rules", async () => {
    // Tokens shorter than 2 chars or longer than 39 chars get filtered
    const e = new LocalEmbeddings();
    const v = await e.embed("a b c"); // each token is 1 char
    expect(v.every(x => x === 0)).toBe(true);
  });
});

describe("LocalEmbeddings — L2 normalization", () => {
  it("output vector has L2 norm of 1 for a meaningful input", async () => {
    const e = new LocalEmbeddings();
    const v = await e.embed("the quick brown fox jumps over the lazy dog");
    const norm = Math.sqrt(v.reduce((acc, x) => acc + x * x, 0));
    expect(norm).toBeGreaterThan(0.99);
    expect(norm).toBeLessThan(1.01);
  });
});

describe("LocalEmbeddings — determinism", () => {
  it("the same text on a fresh instance produces the same vector", async () => {
    const e1 = new LocalEmbeddings();
    const e2 = new LocalEmbeddings();
    const v1 = await e1.embed("repeatable input text here");
    const v2 = await e2.embed("repeatable input text here");
    expect(v1).toEqual(v2);
  });

  it("embedQuery does NOT mutate corpus state — repeated calls are stable", async () => {
    const e = new LocalEmbeddings();
    // Seed corpus
    await e.embedBatch(["alpha bravo charlie", "delta echo foxtrot"]);
    const a = await e.embedQuery("alpha");
    const b = await e.embedQuery("alpha");
    expect(a).toEqual(b);
  });
});

describe("LocalEmbeddings — similarity behavior", () => {
  function dot(a: number[], b: number[]): number {
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * b[i];
    return s;
  }

  it("similar texts have higher cosine similarity than unrelated texts", async () => {
    const e = new LocalEmbeddings();
    await e.embedBatch([
      "machine learning models predict outcomes",
      "deep learning neural networks predict",
      "the weather is nice today",
      "I love sunny weather walks",
    ]);

    const ml1 = await e.embedQuery("machine learning models predict outcomes");
    const ml2 = await e.embedQuery("deep learning neural networks predict");
    const weather = await e.embedQuery("the weather is nice today");

    // Both vectors are L2-normalized, so dot == cosine similarity.
    const simMlPair = dot(ml1, ml2);
    const simMlVsWeather = dot(ml1, weather);

    // ML-to-ML pair should be more similar than ML-to-weather, even with feature hashing.
    expect(simMlPair).toBeGreaterThan(simMlVsWeather);
  });

  it("identical texts produce a cosine similarity of ~1", async () => {
    const e = new LocalEmbeddings();
    await e.embed("same text");
    const a = await e.embedQuery("same text");
    const b = await e.embedQuery("same text");
    const sim = dot(a, b);
    expect(sim).toBeGreaterThan(0.99);
  });
});

describe("LocalEmbeddings — batch behavior", () => {
  it("embedBatch returns one vector per input", async () => {
    const e = new LocalEmbeddings();
    const v = await e.embedBatch(["one two three", "four five six", "seven eight nine"]);
    expect(v).toHaveLength(3);
    expect(v[0]).toHaveLength(256);
  });

  it("empty batch returns empty array", async () => {
    const e = new LocalEmbeddings();
    expect(await e.embedBatch([])).toEqual([]);
  });
});
