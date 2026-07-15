/*
 * Web Worker — impronta vocale (speaker embedding) in locale.
 * Usa WavLM (fine-tuned per speaker verification) via transformers.js per
 * generare un vettore che rappresenta la voce di un intervento. Il
 * raggruppamento in "relatori" avviene nel thread principale (clustering).
 * Nessun dato lascia il dispositivo.
 */
import {
  AutoProcessor,
  AutoModel,
  env,
} from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3";

env.allowLocalModels = false;

let processor = null;
let model = null;
let loaded = false;

async function ensureModel(modelId) {
  if (loaded) return;
  const progress = (p) => self.postMessage({ type: "progress", data: p });
  processor = await AutoProcessor.from_pretrained(modelId, { progress_callback: progress });
  model = await AutoModel.from_pretrained(modelId, { progress_callback: progress, dtype: "fp32" });
  loaded = true;
}

self.onmessage = async (event) => {
  const msg = event.data;

  if (msg.type === "load") {
    try {
      await ensureModel(msg.model);
      self.postMessage({ type: "ready" });
    } catch (err) {
      self.postMessage({ type: "error", error: String(err && err.message || err) });
    }
    return;
  }

  if (msg.type === "embed") {
    if (!loaded) return;
    try {
      const inputs = await processor(msg.audio);
      const output = await model(inputs);
      const tensor = output.embeddings || output.logits;
      const embedding = Array.from(tensor.data);
      self.postMessage({ type: "result", id: msg.id, embedding });
    } catch (err) {
      self.postMessage({ type: "error", error: String(err && err.message || err), id: msg.id });
    }
    return;
  }
};
