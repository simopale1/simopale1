/*
 * CallScribe — Trascrizione live delle call
 *
 * Due sorgenti audio combinate:
 *  - 🎤 Microfono  → la tua voce, via Web Speech API (veloce, nativa)
 *  - 🔊 Audio call → la voce degli altri, catturando l'audio della scheda
 *                    condivisa e trascrivendolo con Whisper IN LOCALE
 *                    (transformers.js). Nessun cavo virtuale, nessuna chiave.
 */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const el = {
    unsupported: $("unsupported"),
    statusPill: $("status-pill"),
    statusText: $("status-text"),
    themeToggle: $("theme-toggle"),
    btnStart: $("btn-start"),
    btnPause: $("btn-pause"),
    btnStop: $("btn-stop"),
    btnCall: $("btn-call"),
    modelSelect: $("model-select"),
    callStatus: $("call-status"),
    translateSelect: $("translate-select"),
    translateStatus: $("translate-status"),
    btnHighlight: $("btn-highlight"),
    btnCopy: $("btn-copy"),
    btnExportMd: $("btn-export-md"),
    btnExportTxt: $("btn-export-txt"),
    btnClear: $("btn-clear"),
    langSelect: $("lang-select"),
    timer: $("timer"),
    transcript: $("transcript"),
    emptyState: $("empty-state"),
    interim: $("interim"),
    wordCount: $("word-count"),
    segmentCount: $("segment-count"),
    autoscroll: $("autoscroll"),
    highlights: $("highlights"),
    notes: $("notes"),
    toast: $("toast"),
  };

  const STORAGE_KEY = "callscribe.session.v2";
  const THEME_KEY = "callscribe.theme";

  // ---- Stato microfono (Web Speech) ----
  let recognition = null;
  let running = false;
  let paused = false;
  let manualStop = false;

  // ---- Stato timer ----
  let startTime = null;
  let elapsedBase = 0;
  let timerInterval = null;

  // ---- Dati sessione ----
  /** @type {{time:number, text:string, highlight:boolean, source:'mic'|'call'}[]} */
  let segments = [];
  /** @type {{time:number, text:string}[]} */
  let highlights = [];

  const SOURCE_LABEL = { mic: "🎤 Tu", call: "🔊 Call" };

  // ============================================================
  // WEB SPEECH API (microfono → la tua voce)
  // ============================================================
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const speechSupported = !!SpeechRecognition;

  function buildRecognition() {
    const rec = new SpeechRecognition();
    rec.lang = el.langSelect.value;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    rec.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result[0].transcript.trim();
        if (!text) continue;
        if (result.isFinal) addSegment(text, "mic");
        else interim += text + " ";
      }
      el.interim.textContent = interim.trim();
    };

    rec.onerror = (event) => {
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        toast("Accesso al microfono negato. Controlla i permessi del browser.");
        stopMic();
      } else if (event.error === "audio-capture") {
        toast("Nessun microfono rilevato.");
        stopMic();
      } else if (event.error === "network") {
        toast("Errore di rete nel servizio di riconoscimento.");
      }
    };

    rec.onend = () => {
      el.interim.textContent = "";
      if (running && !paused && !manualStop) {
        try {
          rec.start();
        } catch (_) {
          setTimeout(() => {
            if (running && !paused && !manualStop) {
              try { rec.start(); } catch (_) {}
            }
          }, 250);
        }
      }
    };
    return rec;
  }

  function startMic() {
    if (!speechSupported) {
      toast("La trascrizione del microfono non è supportata su questo browser.");
      return;
    }
    if (running && !paused) return;
    manualStop = false;
    paused = false;
    running = true;
    recognition = buildRecognition();
    try { recognition.start(); } catch (_) {}
    ensureSession();
    el.langSelect.disabled = true;
    refreshUI();
  }

  function pauseMic() {
    if (!running || paused) return;
    paused = true;
    if (recognition) { try { recognition.stop(); } catch (_) {} }
    refreshUI();
  }

  function resumeMic() { if (paused) startMic(); }

  function stopMic() {
    manualStop = true;
    running = false;
    paused = false;
    if (recognition) {
      try { recognition.stop(); } catch (_) {}
      recognition = null;
    }
    el.interim.textContent = "";
    if (!callActive) el.langSelect.disabled = false;
    refreshUI();
  }

  // ============================================================
  // CATTURA AUDIO CALL (scheda condivisa → Whisper locale)
  // ============================================================
  let callStream = null;
  let audioCtx = null;
  let sourceNode = null;
  let processor = null;
  let zeroGain = null;
  let worker = null;
  let workerReady = false;
  let workerLoading = false;
  let callActive = false;

  const TARGET_RATE = 16000;
  const VAD_THRESHOLD = 0.006;   // energia RMS minima per considerare "voce"
  const SILENCE_MS = 700;        // pausa che chiude un intervento
  const MAX_UTTERANCE_MS = 12000;
  const MIN_UTTERANCE_MS = 400;

  let inputRate = 48000;
  let utterance = [];            // Float32Array a 16 kHz accumulati
  let utteranceMs = 0;
  let silenceMs = 0;
  let speaking = false;
  let segId = 0;

  // Frasi tipiche "allucinate" da Whisper su silenzio/rumore: da scartare.
  const HALLUCINATIONS = new Set([
    "thank you.", "thanks for watching!", "you", ".", "grazie.",
    "sottotitoli e revisione a cura di qtss", "sottotitoli creati dalla comunità amara.org",
  ]);

  function whisperLanguage() {
    const code = el.langSelect.value.slice(0, 2);
    return {
      it: "italian", en: "english", es: "spanish",
      fr: "french", de: "german",
    }[code] || null;
  }

  function initWorker() {
    if (worker) return;
    worker = new Worker("whisper-worker.js", { type: "module" });
    worker.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === "progress") {
        if (msg.data && msg.data.status === "progress" && msg.data.progress != null) {
          setCallStatus(`Caricamento modello… ${Math.round(msg.data.progress)}%`, "loading");
        }
      } else if (msg.type === "info") {
        // es. fallback WebGPU→WASM
      } else if (msg.type === "ready") {
        workerReady = true;
        workerLoading = false;
        setCallStatus("Ascolto audio call…", "active");
      } else if (msg.type === "result") {
        handleCallResult(msg.text);
      } else if (msg.type === "error") {
        console.error("Whisper error:", msg.error);
        if (workerLoading) {
          workerLoading = false;
          setCallStatus("Errore nel caricamento del modello.", "error");
          toast("Impossibile caricare il modello Whisper.");
          teardownCall();
          refreshUI();
        }
      }
    };
  }

  function handleCallResult(text) {
    const clean = (text || "").trim();
    if (!clean) return;
    const lower = clean.toLowerCase();
    if (HALLUCINATIONS.has(lower)) return;
    if (clean.replace(/[^\p{L}\p{N}]/gu, "").length < 2) return; // solo punteggiatura
    addSegment(clean, "call");
  }

  async function startCall() {
    if (callActive) return;

    // 1) Cattura audio della scheda/finestra condivisa.
    let stream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });
    } catch (err) {
      if (err && err.name === "NotAllowedError") toast("Condivisione annullata.");
      else toast("Cattura schermo non disponibile: " + (err && err.name || err));
      return;
    }

    if (stream.getAudioTracks().length === 0) {
      stream.getTracks().forEach((t) => t.stop());
      toast("Nessun audio catturato. Ricorda di attivare “Condividi audio scheda”.");
      return;
    }

    // Il video non serve: lo fermiamo subito per risparmiare risorse.
    stream.getVideoTracks().forEach((t) => t.stop());
    callStream = stream;

    // L'utente può fermare la condivisione dalla barra del browser.
    stream.getAudioTracks()[0].addEventListener("ended", () => {
      if (callActive) { stopCall(); toast("Condivisione audio terminata."); }
    });

    // 2) Prepara il modello Whisper nel worker.
    callActive = true;
    workerReady = false;
    workerLoading = true;
    initWorker();
    setCallStatus("Preparazione modello…", "loading");
    el.langSelect.disabled = true;
    refreshUI();

    const device = ("gpu" in navigator) ? "webgpu" : "wasm";
    worker.postMessage({ type: "load", model: el.modelSelect.value, device });

    // 3) Pipeline audio: cattura → VAD → invio al worker.
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    inputRate = audioCtx.sampleRate;
    sourceNode = audioCtx.createMediaStreamSource(callStream);
    processor = audioCtx.createScriptProcessor(4096, 1, 1);
    zeroGain = audioCtx.createGain();
    zeroGain.gain.value = 0; // evita di riprodurre di nuovo l'audio (niente eco)

    processor.onaudioprocess = (ev) => {
      const input = ev.inputBuffer.getChannelData(0);
      const frameMs = (input.length / inputRate) * 1000;
      const rms = computeRMS(input);
      const resampled = downsample(input, inputRate, TARGET_RATE);

      if (rms > VAD_THRESHOLD) {
        speaking = true;
        silenceMs = 0;
        utterance.push(resampled);
        utteranceMs += frameMs;
      } else if (speaking) {
        utterance.push(resampled);
        utteranceMs += frameMs;
        silenceMs += frameMs;
        if (silenceMs >= SILENCE_MS) flushUtterance();
      }
      if (utteranceMs >= MAX_UTTERANCE_MS) flushUtterance();
    };

    sourceNode.connect(processor);
    processor.connect(zeroGain);
    zeroGain.connect(audioCtx.destination);

    ensureSession();
  }

  function flushUtterance() {
    const chunks = utterance;
    const totalMs = utteranceMs;
    utterance = [];
    utteranceMs = 0;
    silenceMs = 0;
    speaking = false;
    if (totalMs < MIN_UTTERANCE_MS || !worker || !workerReady) return;

    let length = 0;
    for (const c of chunks) length += c.length;
    const audio = new Float32Array(length);
    let offset = 0;
    for (const c of chunks) { audio.set(c, offset); offset += c.length; }

    worker.postMessage(
      { type: "transcribe", audio, language: whisperLanguage(), id: ++segId },
      [audio.buffer]
    );
  }

  function stopCall() {
    teardownCall();
    setCallStatus("", "");
    if (!running && !paused) el.langSelect.disabled = false;
    refreshUI();
  }

  function teardownCall() {
    callActive = false;
    workerReady = false;
    workerLoading = false;
    try { if (processor) processor.disconnect(); } catch (_) {}
    try { if (sourceNode) sourceNode.disconnect(); } catch (_) {}
    try { if (zeroGain) zeroGain.disconnect(); } catch (_) {}
    try { if (audioCtx) audioCtx.close(); } catch (_) {}
    if (callStream) callStream.getTracks().forEach((t) => t.stop());
    processor = sourceNode = zeroGain = audioCtx = callStream = null;
    utterance = [];
    utteranceMs = silenceMs = 0;
    speaking = false;
  }

  function computeRMS(buffer) {
    let sum = 0;
    for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
    return Math.sqrt(sum / buffer.length);
  }

  function downsample(buffer, inRate, outRate) {
    if (inRate === outRate) return Float32Array.from(buffer);
    const ratio = inRate / outRate;
    const newLen = Math.round(buffer.length / ratio);
    const result = new Float32Array(newLen);
    for (let i = 0; i < newLen; i++) {
      const idx = i * ratio;
      const i0 = Math.floor(idx);
      const i1 = Math.min(i0 + 1, buffer.length - 1);
      const frac = idx - i0;
      result[i] = buffer[i0] * (1 - frac) + buffer[i1] * frac;
    }
    return result;
  }

  function setCallStatus(text, cls) {
    el.callStatus.textContent = text;
    el.callStatus.className = "call-status" + (cls ? " " + cls : "") + (text ? "" : " hidden");
  }

  // ============================================================
  // TRADUZIONE IN TEMPO REALE (locale, opus-mt via transformers.js)
  // ============================================================
  let translateWorker = null;
  let translateReady = false;
  let translatePair = null;

  // Coppie supportate (ogni lingua ↔ inglese).
  const OPUS_MODELS = {
    "en-it": "Xenova/opus-mt-en-it", "it-en": "Xenova/opus-mt-it-en",
    "en-es": "Xenova/opus-mt-en-es", "es-en": "Xenova/opus-mt-es-en",
    "en-fr": "Xenova/opus-mt-en-fr", "fr-en": "Xenova/opus-mt-fr-en",
    "en-de": "Xenova/opus-mt-en-de", "de-en": "Xenova/opus-mt-de-en",
  };

  function currentPair() {
    const src = el.langSelect.value.slice(0, 2);
    const tgt = el.translateSelect.value;
    if (!tgt || tgt === src) return null;
    return src + "-" + tgt;
  }

  function initTranslateWorker() {
    if (translateWorker) return;
    translateWorker = new Worker("translate-worker.js", { type: "module" });
    translateWorker.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === "progress") {
        if (msg.data && msg.data.status === "progress" && msg.data.progress != null) {
          setTranslateStatus(`Caricamento traduttore… ${Math.round(msg.data.progress)}%`, "loading");
        }
      } else if (msg.type === "ready") {
        if (msg.pair === translatePair) {
          translateReady = true;
          setTranslateStatus(`🌐 Traduzione attiva (${translatePair})`, "active");
          translateMissing();
        }
      } else if (msg.type === "result") {
        applyTranslation(msg.id, msg.text);
      } else if (msg.type === "error") {
        console.error("Translate error:", msg.error);
        setTranslateStatus("Errore traduttore.", "error");
      }
    };
  }

  // force = true → ricancella e ritraduce tutto (cambio lingua/target).
  // force = false → traduce solo i segmenti ancora senza traduzione (ripristino).
  function setupTranslation(force) {
    const pair = currentPair();
    if (!pair) {
      translatePair = null;
      translateReady = false;
      if (force) clearAllTranslations();
      setTranslateStatus("", "");
      return;
    }
    const model = OPUS_MODELS[pair];
    if (!model) {
      toast(`Traduzione ${pair} non ancora supportata (per ora ogni lingua ↔ inglese).`);
      el.translateSelect.value = "";
      setTranslateStatus("", "");
      return;
    }
    if (force) clearAllTranslations();
    const changed = pair !== translatePair;
    translatePair = pair;
    if (translateReady && !changed) { translateMissing(); return; }

    translateReady = false;
    initTranslateWorker();
    setTranslateStatus("Preparazione traduttore…", "loading");
    translateWorker.postMessage({ type: "load", model, pair });
  }

  function requestTranslation(index) {
    if (!translatePair || !translateReady) return;
    const seg = segments[index];
    if (!seg || seg.translation) return;
    translateWorker.postMessage({ type: "translate", id: index, text: seg.text, pair: translatePair });
  }

  function translateMissing() {
    segments.forEach((s, i) => { if (!s.translation) requestTranslation(i); });
  }

  function applyTranslation(index, text) {
    const seg = segments[index];
    if (!seg || !text) return;
    seg.translation = text;
    const node = el.transcript.querySelector(`.segment[data-index="${index}"]`);
    if (node) {
      let t = node.querySelector(".segment-translation");
      if (!t) {
        t = document.createElement("div");
        t.className = "segment-translation";
        node.appendChild(t);
      }
      t.textContent = text;
    }
    persist();
  }

  function clearAllTranslations() {
    segments.forEach((s) => { delete s.translation; });
    el.transcript.querySelectorAll(".segment-translation").forEach((n) => n.remove());
  }

  function setTranslateStatus(text, cls) {
    el.translateStatus.textContent = text;
    el.translateStatus.className = "call-status" + (cls ? " " + cls : "") + (text ? "" : " hidden");
  }

  // ============================================================
  // SESSIONE / TIMER
  // ============================================================
  function ensureSession() {
    if (!startTime) startTime = Date.now();
    syncTimer();
    refreshUI();
  }

  function anyActive() {
    return (running && !paused) || callActive;
  }

  function syncTimer() {
    if (anyActive() && !timerInterval) startTimer();
    else if (!anyActive() && timerInterval) stopTimer();
  }

  function startTimer() {
    stopTimer();
    const anchor = Date.now();
    timerInterval = setInterval(() => {
      const seconds = elapsedBase + Math.floor((Date.now() - anchor) / 1000);
      el.timer.textContent = formatDuration(seconds);
    }, 500);
  }

  function stopTimer() {
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
      elapsedBase = parseDuration(el.timer.textContent);
    }
  }

  function formatDuration(totalSeconds) {
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
  }

  function parseDuration(str) {
    const parts = str.split(":").map(Number);
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return parts[0] * 60 + parts[1];
  }

  function sessionSeconds() {
    if (!startTime) return 0;
    return parseDuration(el.timer.textContent);
  }

  // ============================================================
  // SEGMENTI TRASCRIZIONE
  // ============================================================
  function addSegment(text, source) {
    const seg = { time: sessionSeconds(), text, highlight: false, source: source || "mic" };
    segments.push(seg);
    renderSegment(seg, segments.length - 1);
    updateStats();
    persist();
    requestTranslation(segments.length - 1);
  }

  function renderSegment(seg, index) {
    if (el.emptyState) { el.emptyState.remove(); el.emptyState = null; }
    const div = document.createElement("div");
    div.className = "segment src-" + (seg.source || "mic") + (seg.highlight ? " is-highlight" : "");
    div.dataset.index = index;
    div.innerHTML =
      `<div class="segment-meta"><span class="src-badge">${SOURCE_LABEL[seg.source] || ""}</span>` +
      `<span class="segment-time">${formatDuration(seg.time)}</span></div>` +
      `<div class="segment-text"></div>`;
    div.querySelector(".segment-text").textContent = seg.text;
    if (seg.translation) {
      const t = document.createElement("div");
      t.className = "segment-translation";
      t.textContent = seg.translation;
      div.appendChild(t);
    }
    el.transcript.appendChild(div);
    if (el.autoscroll.checked) el.transcript.scrollTop = el.transcript.scrollHeight;
  }

  function updateStats() {
    const words = segments.reduce((n, s) => n + s.text.split(/\s+/).filter(Boolean).length, 0);
    el.wordCount.textContent = `${words} parole`;
    el.segmentCount.textContent = `${segments.length} interventi`;
  }

  // ============================================================
  // MOMENTI CHIAVE
  // ============================================================
  function markHighlight() {
    const last = segments[segments.length - 1];
    const text = last ? last.text : "(momento segnato)";
    if (last) last.highlight = true;
    highlights.push({ time: sessionSeconds(), text });
    renderHighlights();
    if (last) {
      const node = el.transcript.querySelector(`.segment[data-index="${segments.length - 1}"]`);
      if (node) node.classList.add("is-highlight");
    }
    persist();
    toast("⭐ Momento segnato");
  }

  function renderHighlights() {
    el.highlights.innerHTML = "";
    if (highlights.length === 0) {
      el.highlights.innerHTML =
        '<li class="muted">Nessun momento segnato. Durante la call premi <b>“+ Segna”</b> per marcare i punti importanti.</li>';
      return;
    }
    highlights.forEach((hl) => {
      const li = document.createElement("li");
      li.className = "highlight-item";
      li.innerHTML =
        `<div class="highlight-time">${formatDuration(hl.time)}</div>` +
        `<div class="highlight-text"></div>`;
      li.querySelector(".highlight-text").textContent = hl.text;
      li.title = "Vai al punto nella trascrizione";
      li.addEventListener("click", () => scrollToTime(hl.time));
      el.highlights.appendChild(li);
    });
  }

  function scrollToTime(time) {
    const idx = segments.findIndex((s) => s.time >= time);
    if (idx >= 0) {
      const node = el.transcript.querySelector(`.segment[data-index="${idx}"]`);
      if (node) node.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

  // ============================================================
  // ESPORTAZIONE
  // ============================================================
  function buildPlainText() {
    const lines = [];
    lines.push("CallScribe — Trascrizione");
    lines.push("Data: " + new Date().toLocaleString("it-IT"));
    lines.push("Durata: " + el.timer.textContent);
    lines.push("Lingua: " + el.langSelect.options[el.langSelect.selectedIndex].text);
    lines.push("");
    lines.push("=== TRASCRIZIONE ===");
    segments.forEach((s) => {
      const src = SOURCE_LABEL[s.source] || "";
      lines.push(`[${formatDuration(s.time)}] ${src}${s.highlight ? " ⭐" : ""}: ${s.text}`);
      if (s.translation) lines.push(`            🌐 ${s.translation}`);
    });
    if (highlights.length) {
      lines.push("");
      lines.push("=== MOMENTI CHIAVE ===");
      highlights.forEach((h) => lines.push(`[${formatDuration(h.time)}] ${h.text}`));
    }
    if (el.notes.value.trim()) {
      lines.push("");
      lines.push("=== APPUNTI ===");
      lines.push(el.notes.value.trim());
    }
    return lines.join("\n");
  }

  function buildMarkdown() {
    const lines = [];
    lines.push("# CallScribe — Trascrizione\n");
    lines.push(`- **Data:** ${new Date().toLocaleString("it-IT")}`);
    lines.push(`- **Durata:** ${el.timer.textContent}`);
    lines.push(`- **Lingua:** ${el.langSelect.options[el.langSelect.selectedIndex].text}\n`);
    if (highlights.length) {
      lines.push("## ⭐ Momenti chiave\n");
      highlights.forEach((h) => lines.push(`- \`${formatDuration(h.time)}\` ${h.text}`));
      lines.push("");
    }
    lines.push("## 💬 Trascrizione\n");
    segments.forEach((s) => {
      const src = SOURCE_LABEL[s.source] || "";
      const mark = s.highlight ? " ⭐" : "";
      lines.push(`**\`${formatDuration(s.time)}\` ${src}**${mark}: ${s.text}`);
      if (s.translation) lines.push(`> 🌐 ${s.translation}`);
      lines.push("");
    });
    if (el.notes.value.trim()) {
      lines.push("## 📝 Appunti\n");
      lines.push(el.notes.value.trim());
    }
    return lines.join("\n");
  }

  function download(filename, content) {
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function timestampName() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, "0");
    return `callscribe_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
  }

  // ============================================================
  // PERSISTENZA
  // ============================================================
  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        segments, highlights,
        notes: el.notes.value,
        elapsed: el.timer.textContent,
        lang: el.langSelect.value,
        translate: el.translateSelect.value,
        savedAt: Date.now(),
      }));
    } catch (_) {}
  }

  function restore() {
    let data;
    try { data = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null"); } catch (_) { return; }
    if (!data || !Array.isArray(data.segments) || data.segments.length === 0) return;
    segments = data.segments.map((s) => ({ source: "mic", highlight: false, ...s }));
    highlights = data.highlights || [];
    el.notes.value = data.notes || "";
    el.timer.textContent = data.elapsed || "00:00";
    elapsedBase = parseDuration(el.timer.textContent);
    if (data.lang) el.langSelect.value = data.lang;
    if (data.translate) el.translateSelect.value = data.translate;
    startTime = Date.now();
    if (el.emptyState) { el.emptyState.remove(); el.emptyState = null; }
    segments.forEach((s, i) => renderSegment(s, i));
    renderHighlights();
    updateStats();
    if (el.translateSelect.value) setupTranslation(false);
    toast("Sessione precedente ripristinata");
  }

  function clearSession() {
    if (!confirm("Cancellare l'intera sessione (trascrizione, momenti e appunti)?")) return;
    stopMic();
    stopCall();
    segments = [];
    highlights = [];
    startTime = null;
    setTranslateStatus("", "");
    elapsedBase = 0;
    el.notes.value = "";
    el.timer.textContent = "00:00";
    el.transcript.innerHTML =
      '<div id="empty-state" class="empty-state">' +
      '<div class="empty-icon">💬</div>' +
      "<p>Premi <b>Avvia</b> (microfono) o <b>Audio call</b> per iniziare a trascrivere.</p>" +
      '<p class="hint">Con le cuffie usa <b>“Audio call”</b> e attiva <b>“Condividi audio scheda”</b>.</p>' +
      "</div>";
    el.emptyState = $("empty-state");
    renderHighlights();
    updateStats();
    try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
    toast("Sessione cancellata");
  }

  // ============================================================
  // UI
  // ============================================================
  function setStatus(cls, text) {
    el.statusPill.className = "status-pill " + cls;
    el.statusText.textContent = text;
  }

  function refreshUI() {
    // Stato globale
    if (anyActive()) setStatus("recording", "Registrazione…");
    else if (paused) setStatus("paused", "In pausa");
    else setStatus("idle", startTime ? "Fermato" : "Pronto");

    // Bottoni microfono
    const micOn = running && !paused;
    el.btnStart.disabled = micOn || !speechSupported;
    el.btnStart.innerHTML = paused
      ? '<span class="btn-icon">▶</span> Riprendi'
      : '<span class="btn-icon">●</span> Avvia';
    el.btnPause.disabled = !micOn;
    el.btnStop.disabled = !running && !paused;

    // Bottone audio call
    el.btnCall.classList.toggle("active", callActive);
    el.btnCall.textContent = callActive ? "⏹ Ferma audio call" : "🔊 Trascrivi audio call";
    el.modelSelect.disabled = callActive;

    el.btnHighlight.disabled = !anyActive() && segments.length === 0;
    syncTimer();
  }

  let toastTimer = null;
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.add("hidden"), 2800);
  }

  async function copyAll() {
    try {
      await navigator.clipboard.writeText(buildPlainText());
      toast("Copiato negli appunti");
    } catch (_) { toast("Copia non riuscita"); }
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    try { localStorage.setItem(THEME_KEY, theme); } catch (_) {}
  }

  function toggleTheme() {
    const current = document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
    applyTheme(current === "dark" ? "light" : "dark");
  }

  // ============================================================
  // BOOTSTRAP
  // ============================================================
  function init() {
    let savedTheme;
    try { savedTheme = localStorage.getItem(THEME_KEY); } catch (_) {}
    if (!savedTheme) {
      savedTheme = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    applyTheme(savedTheme);

    // Cattura audio call richiede getDisplayMedia; il microfono richiede Web Speech.
    const displaySupported = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
    if (!speechSupported && !displaySupported) {
      el.unsupported.classList.remove("hidden");
      el.btnStart.disabled = true;
      el.btnCall.disabled = true;
      setStatus("idle", "Non disponibile");
      return;
    }
    if (!speechSupported) {
      el.btnStart.disabled = true;
      el.btnStart.title = "Microfono non supportato: usa “Audio call”.";
    }
    if (!displaySupported) {
      el.btnCall.disabled = true;
      el.btnCall.title = "Cattura audio scheda non supportata su questo browser.";
    }

    restore();
    refreshUI();
    updateStats();

    el.btnStart.addEventListener("click", () => (paused ? resumeMic() : startMic()));
    el.btnPause.addEventListener("click", pauseMic);
    el.btnStop.addEventListener("click", stopMic);
    el.btnCall.addEventListener("click", () => (callActive ? stopCall() : startCall()));
    el.btnHighlight.addEventListener("click", markHighlight);
    el.btnCopy.addEventListener("click", copyAll);
    el.btnExportTxt.addEventListener("click", () => download(timestampName() + ".txt", buildPlainText()));
    el.btnExportMd.addEventListener("click", () => download(timestampName() + ".md", buildMarkdown()));
    el.btnClear.addEventListener("click", clearSession);
    el.themeToggle.addEventListener("click", toggleTheme);
    el.notes.addEventListener("input", persist);

    el.langSelect.addEventListener("change", () => {
      if (recognition) recognition.lang = el.langSelect.value;
      if (el.translateSelect.value) setupTranslation(true);
      persist();
    });

    el.translateSelect.addEventListener("change", () => {
      setupTranslation(true);
      persist();
    });

    document.addEventListener("keydown", (e) => {
      if (e.target === el.notes) return;
      if (e.code === "Space" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        running && !paused ? pauseMic() : (paused ? resumeMic() : startMic());
      } else if (e.key.toLowerCase() === "m" && (anyActive() || segments.length)) {
        markHighlight();
      }
    });

    window.addEventListener("beforeunload", persist);
  }

  document.addEventListener("DOMContentLoaded", init);
})();
