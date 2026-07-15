/*
 * Web Worker — trascrizione locale con Whisper (transformers.js).
 * Riceve audio PCM mono a 16 kHz e restituisce il testo trascritto.
 * Nessun dato lascia il dispositivo: il modello gira interamente nel browser.
 */
import {
  pipeline,
  env,
} from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3";

// Non cercare modelli locali: scarica da Hugging Face (poi resta in cache).
env.allowLocalModels = false;

let transcriber = null;
let loadedModel = null;

async function ensureModel(model, device, dtype) {
  if (transcriber && loadedModel === model) return;
  transcriber = await pipeline("automatic-speech-recognition", model, {
    device,
    dtype,
    progress_callback: (p) => self.postMessage({ type: "progress", data: p }),
  });
  loadedModel = model;
}

self.onmessage = async (event) => {
  const msg = event.data;

  if (msg.type === "load") {
    try {
      // Prova WebGPU (molto più veloce), con fallback su WASM.
      if (msg.device === "webgpu") {
        try {
          await ensureModel(msg.model, "webgpu", "fp32");
        } catch (gpuErr) {
          self.postMessage({ type: "info", message: "WebGPU non disponibile, uso WASM." });
          await ensureModel(msg.model, "wasm", "q8");
        }
      } else {
        await ensureModel(msg.model, "wasm", "q8");
      }
      self.postMessage({ type: "ready", model: loadedModel });
    } catch (err) {
      self.postMessage({ type: "error", error: String(err && err.message || err) });
    }
    return;
  }

  if (msg.type === "transcribe") {
    if (!transcriber) return;
    try {
      const output = await transcriber(msg.audio, {
        language: msg.language,   // es. "italian", "english" (null = auto)
        task: "transcribe",
        chunk_length_s: 30,
        return_timestamps: false,
      });
      const text = (output && output.text ? output.text : "").trim();
      self.postMessage({ type: "result", id: msg.id, text });
    } catch (err) {
      self.postMessage({ type: "error", error: String(err && err.message || err), id: msg.id });
    }
    return;
  }
};
