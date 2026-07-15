/*
 * CallScribe — Trascrizione live delle call
 * Usa la Web Speech API del browser (nessuna chiave, tutto in locale).
 */
(function () {
  "use strict";

  // ---- Riferimenti DOM ----
  const $ = (id) => document.getElementById(id);
  const el = {
    unsupported: $("unsupported"),
    statusPill: $("status-pill"),
    statusText: $("status-text"),
    themeToggle: $("theme-toggle"),
    btnStart: $("btn-start"),
    btnPause: $("btn-pause"),
    btnStop: $("btn-stop"),
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

  const STORAGE_KEY = "callscribe.session.v1";
  const THEME_KEY = "callscribe.theme";

  // ---- Stato ----
  let recognition = null;
  let running = false;      // riconoscimento attivo
  let paused = false;       // pausa richiesta dall'utente
  let manualStop = false;   // stop richiesto dall'utente (blocca auto-restart)
  let startTime = null;     // ms all'avvio
  let elapsedBase = 0;      // secondi accumulati prima dell'ultima pausa
  let timerInterval = null;

  /** @type {{time:number, text:string, highlight:boolean}[]} */
  let segments = [];
  /** @type {{time:number, text:string}[]} */
  let highlights = [];

  // ============================================================
  // Inizializzazione riconoscimento vocale
  // ============================================================
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;

  function isSupported() {
    return !!SpeechRecognition;
  }

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
        if (result.isFinal) {
          addSegment(text);
        } else {
          interim += text + " ";
        }
      }
      el.interim.textContent = interim.trim();
    };

    rec.onerror = (event) => {
      // "no-speech" e "aborted" sono normali: lasciamo che onend gestisca il riavvio.
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        toast("Accesso al microfono negato. Controlla i permessi del browser.");
        hardStop();
      } else if (event.error === "audio-capture") {
        toast("Nessun microfono rilevato.");
        hardStop();
      } else if (event.error === "network") {
        toast("Errore di rete nel servizio di riconoscimento.");
      }
    };

    rec.onend = () => {
      el.interim.textContent = "";
      // La Web Speech API si ferma da sola dopo pause/silenzi:
      // riavviamo automaticamente finché l'utente non preme Stop/Pausa.
      if (running && !paused && !manualStop) {
        try {
          rec.start();
        } catch (_) {
          /* start troppo ravvicinato: riprova a breve */
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

  // ============================================================
  // Controlli sessione
  // ============================================================
  function start() {
    if (!isSupported()) return;
    if (running && !paused) return;

    manualStop = false;
    paused = false;
    running = true;

    recognition = buildRecognition();
    try {
      recognition.start();
    } catch (err) {
      // Già avviato: ignora.
    }

    if (!startTime) startTime = Date.now();
    startTimer();
    setStatus("recording", "Registrazione…");
    updateControls();
    el.langSelect.disabled = true;
  }

  function pause() {
    if (!running || paused) return;
    paused = true;
    stopTimer();
    if (recognition) {
      try { recognition.stop(); } catch (_) {}
    }
    setStatus("paused", "In pausa");
    updateControls();
  }

  function resume() {
    if (!paused) return;
    start();
  }

  function hardStop() {
    manualStop = true;
    running = false;
    paused = false;
    stopTimer();
    if (recognition) {
      try { recognition.stop(); } catch (_) {}
      recognition = null;
    }
    el.interim.textContent = "";
    setStatus("idle", "Fermato");
    el.langSelect.disabled = false;
    updateControls();
  }

  function updateControls() {
    const active = running && !paused;
    el.btnStart.disabled = active;
    el.btnStart.innerHTML = paused
      ? '<span class="btn-icon">▶</span> Riprendi'
      : '<span class="btn-icon">●</span> Avvia';
    el.btnPause.disabled = !active;
    el.btnStop.disabled = !running && !paused;
    el.btnHighlight.disabled = !running;
  }

  // ============================================================
  // Timer
  // ============================================================
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
      // accumula il tempo trascorso
      if (startTime) {
        const shown = el.timer.textContent;
        elapsedBase = parseDuration(shown);
      }
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

  // ============================================================
  // Segmenti trascrizione
  // ============================================================
  function addSegment(text) {
    const seg = { time: sessionSeconds(), text, highlight: false };
    segments.push(seg);
    renderSegment(seg, segments.length - 1);
    updateStats();
    persist();
  }

  function renderSegment(seg, index) {
    if (el.emptyState) el.emptyState.remove();
    const div = document.createElement("div");
    div.className = "segment" + (seg.highlight ? " is-highlight" : "");
    div.dataset.index = index;
    div.innerHTML =
      `<div class="segment-time">${formatDuration(seg.time)}</div>` +
      `<div class="segment-text"></div>`;
    div.querySelector(".segment-text").textContent = seg.text;
    el.transcript.appendChild(div);
    if (el.autoscroll.checked) {
      el.transcript.scrollTop = el.transcript.scrollHeight;
    }
  }

  function sessionSeconds() {
    if (!startTime) return 0;
    return parseDuration(el.timer.textContent);
  }

  function updateStats() {
    const words = segments.reduce((n, s) => n + s.text.split(/\s+/).filter(Boolean).length, 0);
    el.wordCount.textContent = `${words} parole`;
    el.segmentCount.textContent = `${segments.length} interventi`;
  }

  // ============================================================
  // Momenti chiave (highlight)
  // ============================================================
  function markHighlight() {
    const last = segments[segments.length - 1];
    const text = last ? last.text : "(momento segnato)";
    if (last) last.highlight = true;
    const hl = { time: sessionSeconds(), text };
    highlights.push(hl);
    renderHighlights();
    // aggiorna stile del segmento
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
  // Esportazione
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
      lines.push(`[${formatDuration(s.time)}]${s.highlight ? " ⭐" : ""} ${s.text}`);
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
      const mark = s.highlight ? " ⭐" : "";
      lines.push(`**\`${formatDuration(s.time)}\`**${mark} ${s.text}\n`);
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
  // Persistenza (localStorage)
  // ============================================================
  function persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        segments, highlights,
        notes: el.notes.value,
        elapsed: el.timer.textContent,
        lang: el.langSelect.value,
        savedAt: Date.now(),
      }));
    } catch (_) {}
  }

  function restore() {
    let data;
    try {
      data = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    } catch (_) { return; }
    if (!data || !Array.isArray(data.segments) || data.segments.length === 0) return;

    segments = data.segments;
    highlights = data.highlights || [];
    el.notes.value = data.notes || "";
    el.timer.textContent = data.elapsed || "00:00";
    elapsedBase = parseDuration(el.timer.textContent);
    if (data.lang) el.langSelect.value = data.lang;
    startTime = Date.now(); // consente nuovi timestamp coerenti

    if (el.emptyState) el.emptyState.remove();
    segments.forEach((s, i) => renderSegment(s, i));
    renderHighlights();
    updateStats();
    toast("Sessione precedente ripristinata");
  }

  function clearSession() {
    if (!confirm("Cancellare l'intera sessione (trascrizione, momenti e appunti)?")) return;
    hardStop();
    segments = [];
    highlights = [];
    startTime = null;
    elapsedBase = 0;
    el.notes.value = "";
    el.timer.textContent = "00:00";
    el.transcript.innerHTML =
      '<div id="empty-state" class="empty-state">' +
      '<div class="empty-icon">💬</div>' +
      "<p>Premi <b>Avvia</b> e concedi l'accesso al microfono per iniziare a trascrivere.</p>" +
      '<p class="hint">Suggerimento: metti la call in <b>vivavoce/altoparlanti</b> per catturare anche l\'altra persona.</p>' +
      "</div>";
    el.emptyState = $("empty-state");
    renderHighlights();
    updateStats();
    try { localStorage.removeItem(STORAGE_KEY); } catch (_) {}
    toast("Sessione cancellata");
  }

  // ============================================================
  // UI helpers
  // ============================================================
  function setStatus(cls, text) {
    el.statusPill.className = "status-pill " + cls;
    el.statusText.textContent = text;
  }

  let toastTimer = null;
  function toast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.remove("hidden");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.add("hidden"), 2600);
  }

  async function copyAll() {
    try {
      await navigator.clipboard.writeText(buildPlainText());
      toast("Copiato negli appunti");
    } catch (_) {
      toast("Copia non riuscita");
    }
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
  // Bootstrap
  // ============================================================
  function init() {
    // Tema
    let savedTheme;
    try { savedTheme = localStorage.getItem(THEME_KEY); } catch (_) {}
    if (!savedTheme) {
      savedTheme = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    applyTheme(savedTheme);

    if (!isSupported()) {
      el.unsupported.classList.remove("hidden");
      el.btnStart.disabled = true;
      setStatus("idle", "Non disponibile");
      return;
    }

    restore();
    updateControls();
    updateStats();

    // Eventi
    el.btnStart.addEventListener("click", () => (paused ? resume() : start()));
    el.btnPause.addEventListener("click", pause);
    el.btnStop.addEventListener("click", hardStop);
    el.btnHighlight.addEventListener("click", markHighlight);
    el.btnCopy.addEventListener("click", copyAll);
    el.btnExportTxt.addEventListener("click", () =>
      download(timestampName() + ".txt", buildPlainText()));
    el.btnExportMd.addEventListener("click", () =>
      download(timestampName() + ".md", buildMarkdown()));
    el.btnClear.addEventListener("click", clearSession);
    el.themeToggle.addEventListener("click", toggleTheme);
    el.notes.addEventListener("input", persist);

    el.langSelect.addEventListener("change", () => {
      if (recognition) recognition.lang = el.langSelect.value;
      persist();
    });

    // Scorciatoie da tastiera
    document.addEventListener("keydown", (e) => {
      if (e.target === el.notes) return;
      if (e.code === "Space" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        running && !paused ? pause() : (paused ? resume() : start());
      } else if (e.key.toLowerCase() === "m" && running) {
        markHighlight();
      }
    });

    // Salva prima di chiudere
    window.addEventListener("beforeunload", persist);
  }

  document.addEventListener("DOMContentLoaded", init);
})();
