/*
 * Web Worker — traduzione in locale (transformers.js, modelli Helsinki-NLP opus-mt).
 * Traduce il testo trascritto da una lingua all'altra, senza chiavi né server.
 */
import {
  pipeline,
  env,
} from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3";

env.allowLocalModels = false;

let translator = null;
let loadedModel = null;

async function ensureModel(model) {
  if (translator && loadedModel === model) return;
  translator = await pipeline("translation", model, {
    device: "wasm",
    dtype: "q8",
    progress_callback: (p) => self.postMessage({ type: "progress", data: p }),
  });
  loadedModel = model;
}

self.onmessage = async (event) => {
  const msg = event.data;

  if (msg.type === "load") {
    try {
      await ensureModel(msg.model);
      self.postMessage({ type: "ready", pair: msg.pair });
    } catch (err) {
      self.postMessage({ type: "error", error: String(err && err.message || err) });
    }
    return;
  }

  if (msg.type === "translate") {
    if (!translator) return;
    try {
      const out = await translator(msg.text);
      const text = Array.isArray(out)
        ? (out[0] && out[0].translation_text) || ""
        : (out && out.translation_text) || "";
      self.postMessage({ type: "result", id: msg.id, text: text.trim() });
    } catch (err) {
      self.postMessage({ type: "error", error: String(err && err.message || err), id: msg.id });
    }
    return;
  }
};
