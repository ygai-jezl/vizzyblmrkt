import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import {
  buildPredictBody,
  embeddingBackend,
  embeddingLocation,
  embeddingPredictUrl,
  isEmbeddingsConfigured,
  LOCAL_EMBEDDING_MODEL,
  normalizeVector,
  parsePredictResponse,
  embedQuery,
  embedDocuments,
} from "./embeddings";

// Make the ADC client deterministic for the network-path test.
vi.mock("google-auth-library", () => ({
  GoogleAuth: class {
    async getAccessToken() {
      return "test-token";
    }
  },
}));

// The Gemini Developer API client (laptop path). Never reaches the network.
const { embedContentMock, clientOptions } = vi.hoisted(() => ({
  embedContentMock: vi.fn(),
  clientOptions: [] as unknown[],
}));
vi.mock("@google/genai", () => ({
  GoogleGenAI: class {
    models = { embedContent: embedContentMock };
    constructor(opts: unknown) {
      clientOptions.push(opts);
    }
  },
}));

beforeEach(() => {
  // A key in the developer's shell must not change which backend these tests hit.
  vi.stubEnv("GEMINI_API_KEY", "");
  vi.stubEnv("GOOGLE_GENAI_USE_VERTEXAI", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  embedContentMock.mockReset();
});

describe("embeddingLocation", () => {
  it("maps each region to a regional (non-global) endpoint", () => {
    expect(embeddingLocation("us")).toBe("us-central1");
    expect(embeddingLocation("eu")).toBe("europe-west4");
    expect(embeddingLocation("asia")).toBe("asia-southeast1");
  });
  it("honours per-region overrides", () => {
    vi.stubEnv("EMBEDDINGS_LOCATION_EU", "europe-west1");
    expect(embeddingLocation("eu")).toBe("europe-west1");
  });
});

describe("embeddingPredictUrl", () => {
  it("builds a regional aiplatform :predict url", () => {
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "proj");
    expect(embeddingPredictUrl("us")).toBe(
      "https://us-central1-aiplatform.googleapis.com/v1/projects/proj/locations/us-central1/publishers/google/models/text-embedding-005:predict",
    );
  });
});

describe("buildPredictBody", () => {
  it("sets RETRIEVAL_DOCUMENT + title for documents and 768 outputDimensionality", () => {
    const body = buildPredictBody([{ title: "README", content: "hello" }], "RETRIEVAL_DOCUMENT") as {
      instances: Array<Record<string, unknown>>;
      parameters: Record<string, unknown>;
    };
    expect(body.instances[0]).toEqual({ task_type: "RETRIEVAL_DOCUMENT", title: "README", content: "hello" });
    expect(body.parameters).toEqual({ outputDimensionality: 768, autoTruncate: true });
  });
  it("omits title for query task types", () => {
    const body = buildPredictBody([{ title: "ignored", content: "q" }], "RETRIEVAL_QUERY") as {
      instances: Array<Record<string, unknown>>;
    };
    expect(body.instances[0]).toEqual({ task_type: "RETRIEVAL_QUERY", content: "q" });
  });
});

describe("parsePredictResponse", () => {
  it("extracts embeddings.values per prediction", () => {
    const out = parsePredictResponse({
      predictions: [{ embeddings: { values: [1, 2, 3] } }, { embeddings: { values: [4, 5] } }],
    });
    expect(out).toEqual([[1, 2, 3], [4, 5]]);
  });
  it("throws on a malformed response", () => {
    expect(() => parsePredictResponse({})).toThrow();
    expect(() => parsePredictResponse({ predictions: [{}] })).toThrow();
  });
});

describe("isEmbeddingsConfigured", () => {
  it("requires GOOGLE_CLOUD_PROJECT (or a Gemini key, below)", () => {
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "");
    expect(isEmbeddingsConfigured()).toBe(false);
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "proj");
    expect(isEmbeddingsConfigured()).toBe(true);
  });

  it("is off on an emulator-only demo project without a Gemini key", () => {
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "demo-yougrow");
    expect(isEmbeddingsConfigured()).toBe(false);
  });
});

describe("embeddingBackend", () => {
  it("uses Vertex whenever a real project is set, key or not (deployed environments)", () => {
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "my-project");
    expect(embeddingBackend()).toBe("vertex");
    vi.stubEnv("GEMINI_API_KEY", "AIza-test");
    expect(embeddingBackend()).toBe("vertex");
  });

  it("uses the Gemini Developer API with a classic key and no real project", () => {
    vi.stubEnv("GEMINI_API_KEY", "AIza-test");
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "demo-yougrow");
    expect(embeddingBackend()).toBe("gemini-api");
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "");
    expect(embeddingBackend()).toBe("gemini-api");
  });

  it("treats a key with GOOGLE_GENAI_USE_VERTEXAI=true as a Vertex express key, not a laptop key", () => {
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "demo-yougrow");
    vi.stubEnv("GEMINI_API_KEY", "AQ.test");
    vi.stubEnv("GOOGLE_GENAI_USE_VERTEXAI", "true");
    expect(embeddingBackend()).toBeNull();
  });
});

describe("normalizeVector", () => {
  it("scales to unit length and leaves a zero vector alone", () => {
    expect(normalizeVector([3, 4])).toEqual([0.6, 0.8]);
    expect(normalizeVector([0, 0])).toEqual([0, 0]);
  });
});

describe("Gemini Developer API path (laptop)", () => {
  const vec = (fill: number) => Array.from({ length: 768 }, () => fill);
  const laptop = () => {
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "demo-yougrow");
    vi.stubEnv("GEMINI_API_KEY", "AIza-test");
  };

  it("embeds a query with the same task type and 768 dimensions, normalised, without calling Vertex", async () => {
    laptop();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    embedContentMock.mockResolvedValue({ embeddings: [{ values: vec(2) }] });
    const out = await embedQuery("what is the pricing", "us");
    expect(out).toHaveLength(768);
    expect(out![0]).toBeCloseTo(1 / Math.sqrt(768));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(clientOptions.at(-1)).toEqual({ apiKey: "AIza-test" });
    expect(embedContentMock).toHaveBeenCalledWith({
      model: LOCAL_EMBEDDING_MODEL,
      contents: ["what is the pricing"],
      config: { taskType: "RETRIEVAL_QUERY", outputDimensionality: 768 },
    });
  });

  it("uses CODE_RETRIEVAL_QUERY when code:true", async () => {
    laptop();
    embedContentMock.mockResolvedValue({ embeddings: [{ values: vec(1) }] });
    await embedQuery("sort an array", "us", { code: true });
    expect(embedContentMock.mock.calls[0]![0].config.taskType).toBe("CODE_RETRIEVAL_QUERY");
  });

  it("embeds documents in runs that share a title, keeping input order and null for empty input", async () => {
    laptop();
    embedContentMock
      .mockResolvedValueOnce({ embeddings: [{ values: vec(1) }, { values: vec(2) }] })
      .mockResolvedValueOnce({ embeddings: [{ values: vec(3) }] });
    const out = await embedDocuments(
      [{ content: "Share of voice", title: "Subject" }, { content: " " }, { content: "Citations", title: "Subject" }, { content: "Pricing", title: "Question" }],
      "us",
    );
    expect(out[1]).toBeNull();
    expect(out.filter(Boolean)).toHaveLength(3);
    expect(embedContentMock).toHaveBeenCalledTimes(2);
    expect(embedContentMock.mock.calls[0]![0]).toEqual({
      model: LOCAL_EMBEDDING_MODEL,
      contents: ["Share of voice", "Citations"],
      config: { taskType: "RETRIEVAL_DOCUMENT", outputDimensionality: 768, title: "Subject" },
    });
    expect(embedContentMock.mock.calls[1]![0].config.title).toBe("Question");
  });

  it("degrades to null on an API error or a wrong-sized vector (never throws)", async () => {
    laptop();
    embedContentMock.mockRejectedValueOnce(new Error("quota"));
    expect(await embedQuery("q", "us")).toBeNull();
    embedContentMock.mockResolvedValueOnce({ embeddings: [{ values: [1, 2, 3] }] });
    expect(await embedQuery("q", "us")).toBeNull();
    embedContentMock.mockResolvedValueOnce({ embeddings: [] });
    expect(await embedDocuments([{ content: "a" }], "us")).toEqual([null]);
  });
});

describe("embedQuery", () => {
  it("returns null when unconfigured or empty (degrade, never throw)", async () => {
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "");
    expect(await embedQuery("hi", "us")).toBeNull();
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "proj");
    expect(await embedQuery("   ", "us")).toBeNull();
  });

  it("returns the vector on success using RETRIEVAL_QUERY", async () => {
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "proj");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ predictions: [{ embeddings: { values: [0.1, 0.2, 0.3] } }] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const vec = await embedQuery("what is the pricing", "us");
    expect(vec).toEqual([0.1, 0.2, 0.3]);
    // Asserted the asymmetric query task type went out on the wire.
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.instances[0].task_type).toBe("RETRIEVAL_QUERY");
  });

  it("uses CODE_RETRIEVAL_QUERY when code:true", async () => {
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "proj");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ predictions: [{ embeddings: { values: [1] } }] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    await embedQuery("sort an array", "us", { code: true });
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.instances[0].task_type).toBe("CODE_RETRIEVAL_QUERY");
  });

  it("returns null (not throw) when the API errors", async () => {
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "proj");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => "boom" }));
    expect(await embedQuery("q", "us")).toBeNull();
  });
});

describe("embedDocuments", () => {
  it("embeds several documents in one request, one vector per input and null for an empty one", async () => {
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "proj");
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ predictions: [{ embeddings: { values: [1, 0] } }, { embeddings: { values: [0, 1] } }] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const out = await embedDocuments([{ content: "Share of voice" }, { content: "  " }, { content: "Citations", title: "Subject" }], "us");
    expect(out).toEqual([[1, 0], null, [0, 1]]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.instances.map((i: { task_type: string }) => i.task_type)).toEqual(["RETRIEVAL_DOCUMENT", "RETRIEVAL_DOCUMENT"]);
  });

  it("gives every slot null when unconfigured or when the API errors (never throws)", async () => {
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "");
    expect(await embedDocuments([{ content: "a" }], "us")).toEqual([null]);
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "proj");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500, text: async () => "boom" }));
    expect(await embedDocuments([{ content: "a" }, { content: "b" }], "us")).toEqual([null, null]);
  });
});
