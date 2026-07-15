# 🗺️ Roadmap

Idee e prossimi passi per far crescere CallScribe.

## ✅ Fatto (MVP)
- Trascrizione live via Web Speech API (IT/EN + altre lingue)
- Momenti chiave, appunti, timer, statistiche
- Esportazione `.md` / `.txt`, copia, salvataggio automatico locale
- Tema chiaro/scuro, scorciatoie da tastiera

## 🔜 Prossimo
- [ ] **Backend Whisper / Deepgram**: streaming dell'audio della scheda
      (`getDisplayMedia`) per catturare entrambi i lati della call senza cavi
      virtuali e con precisione maggiore.
- [ ] **Modello locale (offline)**: trascrizione 100% in-browser con
      `transformers.js` / `whisper.cpp` WASM — nessun dato esce dal dispositivo.
- [ ] **Diarizzazione**: distinguere gli interlocutori ("Speaker 1", "Speaker 2").
- [ ] **Riassunto automatico** e action items via LLM a fine call.
- [ ] **Ricerca** nella trascrizione.
- [ ] **Cronologia sessioni** (più call salvate, non solo l'ultima).

## 💭 Idee future
- [ ] Traduzione live (IT ⇄ EN).
- [ ] Integrazione calendario per titolare automaticamente la riunione.
- [ ] Esportazione verso Notion / Google Docs.
- [ ] PWA installabile con supporto offline.

Hai un'idea? Aprila come issue. 🙌
