# 🗺️ Roadmap

Idee e prossimi passi per far crescere CallScribe.

## ✅ Fatto (MVP)
- Trascrizione live via Web Speech API (IT/EN + altre lingue)
- **Audio della call con Whisper in locale** (transformers.js): cattura la voce
  degli altri anche con le cuffie, senza cavi virtuali e senza chiavi API
- **Traduzione in tempo reale in locale** (opus-mt): call in un'altra lingua
  mostrata anche nella tua, sotto ogni frase
- **Distinzione dei relatori** (WavLM): raggruppa le voci in Relatore 1, 2, 3…
  con correzione manuale (rinomina, riassegna, unisci)
- VAD (voice activity detection) per segmentare gli interventi
- Momenti chiave, appunti, timer, statistiche
- Esportazione `.md` / `.txt` (con etichetta sorgente), copia, salvataggio locale
- Tema chiaro/scuro, scorciatoie da tastiera

## 🔜 Prossimo
- [ ] **Riassunto automatico + action items** a fine call.
- [ ] **Modello 100% offline**: includere i pesi del modello (o cache-first PWA)
      per non dipendere dalla CDN.
- [ ] **Diarizzazione più robusta**: gestire meglio il parlato sovrapposto.
- [ ] **Backend opzionale** (Whisper/Deepgram lato server) per dispositivi deboli.
- [ ] **Riassunto automatico** e action items via LLM a fine call.
- [ ] **Ricerca** nella trascrizione.
- [ ] **Cronologia sessioni** (più call salvate, non solo l'ultima).

## 💭 Idee future
- [ ] Traduzione anche tra coppie senza inglese (pivot it→en→fr).
- [ ] Integrazione calendario per titolare automaticamente la riunione.
- [ ] Esportazione verso Notion / Google Docs.
- [ ] PWA installabile con supporto offline.

Hai un'idea? Aprila come issue. 🙌
