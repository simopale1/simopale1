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
    diarize: $("diarize"),
    speakerStatus: $("speaker-status"),
    speakersSection: $("speakers-section"),
    speakers: $("speakers"),
    diarSensitivity: $("diar-sensitivity"),
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
        handleCallResult(msg.text, msg.id);
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

  function handleCallResult(text, uid) {
    const clean = (text || "").trim();
    const valid = clean &&
      !HALLUCINATIONS.has(clean.toLowerCase()) &&
      clean.replace(/[^\p{L}\p{N}]/gu, "").length >= 2; // non solo punteggiatura
    if (!valid) { if (uid != null) callPending.delete(uid); return; }

    const index = addSegment(clean, "call");
    if (uid != null) {
      const pend = callPending.get(uid);
      if (pend) {
        pend.index = index;
        if (pend.speaker != null) {
          applySpeakerToSegment(index, pend.speaker);
          callPending.delete(uid);
        }
      }
    }
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

    ensureDiarization();
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

    const uid = ++segId;
    // Diarizzazione: invia una COPIA dell'audio al modello voci (prima del transfer).
    if (diarizeEnabled && speakerWorker && speakerReady) {
      const copy = Float32Array.from(audio);
      callPending.set(uid, {});
      speakerWorker.postMessage({ type: "embed", id: uid, audio: copy }, [copy.buffer]);
    }
    worker.postMessage(
      { type: "transcribe", audio, language: whisperLanguage(), id: uid },
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
    callPending.clear();
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
  // DIARIZZAZIONE — distinzione dei relatori (impronta vocale locale)
  // ============================================================
  const SPEAKER_MODEL = "Xenova/wavlm-base-plus-sv";
  const SPEAKER_COLORS = [
    "#e5484d", "#4f46e5", "#2f9e44", "#f5a623", "#e93d82",
    "#0ea5e9", "#8b5cf6", "#14b8a6", "#f97316", "#64748b",
  ];

  let diarizeEnabled = false;
  let speakerWorker = null;
  let speakerReady = false;
  let speakerLoading = false;
  let diarThreshold = 0.5;
  /** @type {{id:number,name:string,color:string,centroid:Float32Array|null,count:number}[]} */
  let speakers = [];
  let nextSpeakerId = 1;
  const callPending = new Map(); // uid → { index?, speaker? }

  function speakerById(id) { return speakers.find((s) => s.id === id) || null; }

  function cosine(a, b) {
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
    return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-8);
  }

  function createSpeaker(centroid) {
    const id = nextSpeakerId++;
    const color = SPEAKER_COLORS[(id - 1) % SPEAKER_COLORS.length];
    // nEmb = numero di impronte nel centroide; count = interventi mostrati.
    speakers.push({
      id, name: "Relatore " + id, color,
      centroid: centroid || null, nEmb: centroid ? 1 : 0, count: 0,
    });
    return id;
  }

  // Clustering online: confronta con i centroidi esistenti, altrimenti nuovo relatore.
  function assignSpeaker(embedding) {
    const emb = Float32Array.from(embedding);
    let best = -1, bestSim = -1;
    speakers.forEach((sp, idx) => {
      if (!sp.centroid) return;
      const sim = cosine(emb, sp.centroid);
      if (sim > bestSim) { bestSim = sim; best = idx; }
    });
    if (best >= 0 && bestSim >= diarThreshold) {
      const sp = speakers[best];
      const n = sp.nEmb || 1;
      for (let i = 0; i < sp.centroid.length; i++) {
        sp.centroid[i] = (sp.centroid[i] * n + emb[i]) / (n + 1);
      }
      sp.nEmb = n + 1;
      return sp.id;
    }
    return createSpeaker(emb);
  }

  function initSpeakerWorker() {
    if (speakerWorker) return;
    speakerWorker = new Worker("speaker-worker.js", { type: "module" });
    speakerWorker.onmessage = (e) => {
      const msg = e.data;
      if (msg.type === "progress") {
        if (msg.data && msg.data.status === "progress" && msg.data.progress != null) {
          setSpeakerStatus(`Caricamento voci… ${Math.round(msg.data.progress)}%`, "loading");
        }
      } else if (msg.type === "ready") {
        speakerReady = true;
        speakerLoading = false;
        setSpeakerStatus("👥 Distinzione relatori attiva", "active");
      } else if (msg.type === "result") {
        const sid = assignSpeaker(msg.embedding);
        const pend = callPending.get(msg.id);
        if (pend) {
          pend.speaker = sid;
          if (pend.index != null) {
            applySpeakerToSegment(pend.index, sid);
            callPending.delete(msg.id);
          }
        }
        renderSpeakers();
      } else if (msg.type === "error") {
        console.error("Speaker error:", msg.error);
        if (speakerLoading) {
          speakerLoading = false;
          setSpeakerStatus("Modello voci non disponibile.", "error");
          toast("Impossibile caricare il modello per i relatori.");
        }
      }
    };
  }

  function ensureDiarization() {
    if (!diarizeEnabled || !callActive) return;
    if (speakerReady) { setSpeakerStatus("👥 Distinzione relatori attiva", "active"); return; }
    if (speakerLoading) return;
    initSpeakerWorker();
    speakerLoading = true;
    setSpeakerStatus("Preparazione modello voci…", "loading");
    speakerWorker.postMessage({ type: "load", model: SPEAKER_MODEL });
  }

  function applySpeakerToSegment(index, sid) {
    const seg = segments[index];
    if (!seg) return;
    const sp = speakerById(sid);
    if (sp) sp.count++;
    seg.speaker = sid;
    const node = el.transcript.querySelector(`.segment[data-index="${index}"]`);
    if (node) renderSegmentBadge(node, seg, index);
    renderSpeakers();
    persist();
  }

  function reassignSegment(index, sid) {
    const seg = segments[index];
    if (!seg) return;
    const prev = speakerById(seg.speaker);
    if (prev) prev.count = Math.max(0, prev.count - 1);
    const next = speakerById(sid);
    if (next) next.count++;
    seg.speaker = sid;
    const node = el.transcript.querySelector(`.segment[data-index="${index}"]`);
    if (node) renderSegmentBadge(node, seg, index);
    renderSpeakers();
    persist();
  }

  function renameSpeaker(id) {
    const sp = speakerById(id);
    if (!sp) return;
    const name = prompt("Nome del relatore:", sp.name);
    if (name && name.trim()) {
      sp.name = name.trim();
      renderSpeakers();
      refreshCallBadges();
      persist();
    }
  }

  function mergeSpeakers(fromId, toId) {
    if (fromId === toId) return;
    const from = speakerById(fromId), to = speakerById(toId);
    if (!from || !to) return;
    segments.forEach((s) => { if (s.speaker === fromId) s.speaker = toId; });
    to.count += from.count;
    speakers = speakers.filter((s) => s.id !== fromId);
    renderSpeakers();
    refreshCallBadges();
    persist();
    toast(`Uniti in “${to.name}”`);
  }

  function refreshCallBadges() {
    segments.forEach((s, i) => {
      if (s.source !== "call") return;
      const node = el.transcript.querySelector(`.segment[data-index="${i}"]`);
      if (node) renderSegmentBadge(node, s, i);
    });
  }

  // Badge di un segmento: per la call mostra il relatore (cliccabile per riassegnare).
  function renderSegmentBadge(node, seg, index) {
    const badge = node.querySelector(".src-badge");
    if (!badge) return;
    badge.className = "src-badge";
    badge.style.color = "";
    badge.style.borderColor = "";
    badge.onclick = null;
    badge.style.cursor = "";
    badge.removeAttribute("title");

    if (seg.source === "call" && seg.speaker != null) {
      const sp = speakerById(seg.speaker);
      badge.textContent = "🔊 " + (sp ? sp.name : "Relatore");
      badge.classList.add("speaker-badge");
      if (sp) { badge.style.color = sp.color; badge.style.borderColor = sp.color; }
      badge.style.cursor = "pointer";
      badge.title = "Clicca per riassegnare il relatore";
      badge.onclick = (e) => { e.stopPropagation(); openSpeakerMenu(index, badge); };
    } else {
      badge.textContent = SOURCE_LABEL[seg.source] || "";
    }
  }

  function renderSpeakers() {
    el.speakersSection.classList.toggle("hidden", !diarizeEnabled && speakers.length === 0);
    el.speakers.innerHTML = "";
    if (speakers.length === 0) {
      el.speakers.innerHTML = '<li class="muted">Nessun relatore ancora: compariranno qui appena qualcuno parla nella call.</li>';
      return;
    }
    speakers.forEach((sp) => {
      const li = document.createElement("li");
      li.className = "speaker-item";
      const dot = document.createElement("span");
      dot.className = "speaker-dot";
      dot.style.background = sp.color;
      const name = document.createElement("span");
      name.className = "speaker-name";
      name.textContent = sp.name;
      const count = document.createElement("span");
      count.className = "speaker-count";
      count.textContent = sp.count;
      const rename = document.createElement("button");
      rename.className = "spk-btn";
      rename.textContent = "✏️";
      rename.title = "Rinomina";
      rename.onclick = () => renameSpeaker(sp.id);
      const merge = document.createElement("button");
      merge.className = "spk-btn";
      merge.textContent = "⧉";
      merge.title = "Unisci in un altro relatore";
      merge.onclick = (e) => openMergeMenu(sp.id, e.currentTarget);
      li.append(dot, name, count, rename, merge);
      el.speakers.appendChild(li);
    });
  }

  // --- Popover di scelta relatore (riassegna / unisci) ---
  let openMenuEl = null;
  function closeMenus() {
    if (openMenuEl) { openMenuEl.remove(); openMenuEl = null; }
    document.removeEventListener("click", closeMenus);
  }
  function buildSpeakerMenu(items, addNew) {
    closeMenus();
    const menu = document.createElement("div");
    menu.className = "speaker-menu";
    items.forEach(({ sp, onClick }) => {
      const b = document.createElement("button");
      const dot = document.createElement("span");
      dot.className = "speaker-dot";
      dot.style.background = sp.color;
      const label = document.createElement("span");
      label.textContent = sp.name;
      b.append(dot, label);
      b.onclick = (e) => { e.stopPropagation(); onClick(); closeMenus(); };
      menu.appendChild(b);
    });
    if (addNew) {
      const b = document.createElement("button");
      b.textContent = "➕ Nuovo relatore";
      b.onclick = (e) => { e.stopPropagation(); addNew(); closeMenus(); };
      menu.appendChild(b);
    }
    return menu;
  }
  function placeMenu(menu, anchor) {
    document.body.appendChild(menu);
    const r = anchor.getBoundingClientRect();
    menu.style.top = (window.scrollY + r.bottom + 4) + "px";
    menu.style.left = (window.scrollX + r.left) + "px";
    openMenuEl = menu;
    setTimeout(() => document.addEventListener("click", closeMenus), 0);
  }
  function openSpeakerMenu(index, anchor) {
    const items = speakers.map((sp) => ({ sp, onClick: () => reassignSegment(index, sp.id) }));
    const menu = buildSpeakerMenu(items, () => {
      const id = createSpeaker();
      reassignSegment(index, id);
    });
    placeMenu(menu, anchor);
  }
  function openMergeMenu(fromId, anchor) {
    const items = speakers.filter((s) => s.id !== fromId)
      .map((sp) => ({ sp, onClick: () => mergeSpeakers(fromId, sp.id) }));
    if (items.length === 0) { toast("Serve almeno un altro relatore per unire."); return; }
    placeMenu(buildSpeakerMenu(items, null), anchor);
  }

  function setSpeakerStatus(text, cls) {
    el.speakerStatus.textContent = text;
    el.speakerStatus.className = "call-status" + (cls ? " " + cls : "") + (text ? "" : " hidden");
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
    const index = segments.length - 1;
    renderSegment(seg, index);
    updateStats();
    persist();
    requestTranslation(index);
    return index;
  }

  function renderSegment(seg, index) {
    if (el.emptyState) { el.emptyState.remove(); el.emptyState = null; }
    const div = document.createElement("div");
    div.className = "segment src-" + (seg.source || "mic") + (seg.highlight ? " is-highlight" : "");
    div.dataset.index = index;
    div.innerHTML =
      `<div class="segment-meta"><span class="src-badge"></span>` +
      `<span class="segment-time">${formatDuration(seg.time)}</span></div>` +
      `<div class="segment-text"></div>`;
    div.querySelector(".segment-text").textContent = seg.text;
    renderSegmentBadge(div, seg, index);
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
  function exportSpeakerLabel(seg) {
    if (seg.source === "call" && seg.speaker != null) {
      const sp = speakerById(seg.speaker);
      return "🔊 " + (sp ? sp.name : "Relatore");
    }
    return SOURCE_LABEL[seg.source] || "";
  }

  function buildPlainText() {
    const lines = [];
    lines.push("CallScribe — Trascrizione");
    lines.push("Data: " + new Date().toLocaleString("it-IT"));
    lines.push("Durata: " + el.timer.textContent);
    lines.push("Lingua: " + el.langSelect.options[el.langSelect.selectedIndex].text);
    lines.push("");
    lines.push("=== TRASCRIZIONE ===");
    segments.forEach((s) => {
      const src = exportSpeakerLabel(s);
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
      const src = exportSpeakerLabel(s);
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
        diarize: diarizeEnabled,
        diarThreshold,
        nextSpeakerId,
        speakers: speakers.map((s) => ({
          id: s.id, name: s.name, color: s.color, count: s.count, nEmb: s.nEmb || 0,
          centroid: s.centroid ? Array.from(s.centroid) : null,
        })),
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

    // Relatori (prima di renderizzare i segmenti, così i badge si risolvono).
    if (Array.isArray(data.speakers)) {
      speakers = data.speakers.map((s) => ({
        id: s.id, name: s.name, color: s.color, count: s.count || 0, nEmb: s.nEmb || 0,
        centroid: s.centroid ? Float32Array.from(s.centroid) : null,
      }));
    }
    if (data.nextSpeakerId) nextSpeakerId = data.nextSpeakerId;
    if (typeof data.diarThreshold === "number") {
      diarThreshold = data.diarThreshold;
      el.diarSensitivity.value = String(diarThreshold);
    }
    if (data.diarize) {
      diarizeEnabled = true;
      el.diarize.checked = true;
    }

    startTime = Date.now();
    if (el.emptyState) { el.emptyState.remove(); el.emptyState = null; }
    segments.forEach((s, i) => renderSegment(s, i));
    renderHighlights();
    renderSpeakers();
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
    speakers = [];
    nextSpeakerId = 1;
    callPending.clear();
    startTime = null;
    setTranslateStatus("", "");
    setSpeakerStatus("", "");
    renderSpeakers();
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

    el.diarize.addEventListener("change", () => {
      diarizeEnabled = el.diarize.checked;
      renderSpeakers();
      if (diarizeEnabled) {
        ensureDiarization();
        if (!callActive) toast("Attiva “Trascrivi audio call” per distinguere i relatori.");
      } else {
        setSpeakerStatus("", "");
      }
      persist();
    });

    el.diarSensitivity.addEventListener("input", () => {
      diarThreshold = parseFloat(el.diarSensitivity.value);
    });
    el.diarSensitivity.addEventListener("change", persist);

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
