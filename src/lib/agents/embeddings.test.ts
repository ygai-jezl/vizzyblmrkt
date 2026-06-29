import { describe, it, expect, afterEach, vi } from "vitest";
import {
  buildPredictBody,
  embeddingLocation,
  embeddingPredictUrl,
  isEmbeddingsConfigured,
  parsePredictResponse,
  embedQuery,
} from "./embeddings";

// Make the ADC client deterministic for the network-path test.
vi.mock("google-auth-library", () => ({
  GoogleAuth: class {
    async getAccessToken() {
      return "test-token";
    }
  },
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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
  it("requires GOOGLE_CLOUD_PROJECT", () => {
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "");
    expect(isEmbeddingsConfigured()).toBe(false);
    vi.stubEnv("GOOGLE_CLOUD_PROJECT", "proj");
    expect(isEmbeddingsConfigured()).toBe(true);
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
