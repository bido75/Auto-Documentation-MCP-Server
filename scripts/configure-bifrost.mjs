#!/usr/bin/env node

const baseUrl = process.env.BIFROST_URL || "http://localhost:8080";
const ollamaUrl = process.env.BIFROST_OLLAMA_URL || "http://ollama:11434";
const keyName = process.env.BIFROST_OLLAMA_KEY_NAME || "local-ollama";
const requestTimeoutSeconds = Number(process.env.BIFROST_PROVIDER_TIMEOUT_SECONDS || 600);
const testModel = process.env.BIFROST_VALIDATE_MODEL || "ollama/qwen2.5-coder:7b-instruct-q4_K_M";

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function request(path, options = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options.headers || {})
    }
  });

  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!res.ok) {
    const body = typeof data === "string" ? data : JSON.stringify(data);
    throw new Error(`${options.method || "GET"} ${path} failed (${res.status}): ${body}`);
  }

  return data;
}

function unwrapMaskedValue(input, fallback = "") {
  if (typeof input === "string") return input;
  if (input && typeof input === "object" && typeof input.value === "string") return input.value;
  return fallback;
}

async function waitForBifrost() {
  for (let i = 0; i < 60; i += 1) {
    try {
      await request("/api/providers");
      return;
    } catch {
      await sleep(2000);
    }
  }

  throw new Error(`Bifrost API did not become ready at ${baseUrl} within 120s.`);
}

async function ensureOllamaKey() {
  const list = await request("/api/providers/ollama/keys");
  const keys = Array.isArray(list?.keys) ? list.keys : [];
  let existing = keys.find((k) => k?.name === keyName) || keys[0];

  if (!existing) {
    existing = await request("/api/providers/ollama/keys", {
      method: "POST",
      body: JSON.stringify({
        ollama_key_config: {
          url: ollamaUrl
        }
      })
    });
  }

  const keyId = existing?.id;
  if (!keyId) {
    throw new Error("Unable to determine Ollama key ID after creation/read.");
  }

  const updated = await request(`/api/providers/ollama/keys/${keyId}`, {
    method: "PUT",
    body: JSON.stringify({
      id: keyId,
      name: keyName,
      value: {
        value: "",
        env_var: "",
        from_env: false
      },
      models: ["*"],
      blacklisted_models: [],
      weight: Number(existing?.weight || 1),
      ollama_key_config: {
        url: ollamaUrl
      },
      enabled: true,
      use_for_batch_api: false
    })
  });

  const configuredUrl = unwrapMaskedValue(updated?.ollama_key_config?.url, "<masked>");
  console.log(`Configured Ollama key '${keyName}' (${keyId}) with URL ${configuredUrl} and models=*.`);
}

async function ensureProviderTimeout() {
  const providersResp = await request("/api/providers");
  const provider = (providersResp?.providers || []).find((p) => p?.name === "ollama");
  if (!provider) {
    throw new Error("Ollama provider not found in /api/providers.");
  }

  const networkConfig = {
    default_request_timeout_in_seconds: requestTimeoutSeconds,
    max_retries: Number(provider?.network_config?.max_retries ?? 0),
    retry_backoff_initial: Number(provider?.network_config?.retry_backoff_initial ?? 500),
    retry_backoff_max: Number(provider?.network_config?.retry_backoff_max ?? 5000),
    stream_idle_timeout_in_seconds: Math.max(Number(provider?.network_config?.stream_idle_timeout_in_seconds ?? 120), 120),
    max_conns_per_host: Number(provider?.network_config?.max_conns_per_host ?? 5000)
  };

  await request("/api/providers/ollama", {
    method: "PUT",
    body: JSON.stringify({
      name: "ollama",
      network_config: networkConfig,
      concurrency_and_buffer_size: {
        concurrency: Number(provider?.concurrency_and_buffer_size?.concurrency ?? 1000),
        buffer_size: Number(provider?.concurrency_and_buffer_size?.buffer_size ?? 5000)
      },
      send_back_raw_request: Boolean(provider?.send_back_raw_request ?? false),
      send_back_raw_response: Boolean(provider?.send_back_raw_response ?? false),
      store_raw_request_response: Boolean(provider?.store_raw_request_response ?? false),
      provider_status: provider?.provider_status || "active"
    })
  });

  console.log(`Updated Ollama provider timeout to ${requestTimeoutSeconds}s.`);
}

async function verifyInference() {
  try {
    const body = {
      model: testModel,
      messages: [{ role: "user", content: "Reply exactly: ok" }],
      max_tokens: 4,
      temperature: 0
    };

    const out = await request("/v1/chat/completions", {
      method: "POST",
      body: JSON.stringify(body)
    });

    const content = out?.choices?.[0]?.message?.content || "<no content>";
    console.log(`Inference check passed using ${testModel}: ${content}`);
  } catch (error) {
    console.warn(`Inference check failed (non-fatal): ${error.message}`);
  }
}

async function main() {
  await waitForBifrost();
  await ensureOllamaKey();
  await ensureProviderTimeout();
  await verifyInference();
  console.log("Bifrost runtime configuration complete.");
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
