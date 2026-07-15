# 🎙️ CallScribe

**Trascrizione in tempo reale delle call (Teams, Meet, Zoom…) in italiano e inglese.**
Prendi appunti durante le riunioni senza perderti le cose importanti.

CallScribe è una web app leggera che gira **interamente nel tuo browser**: nessun
account, nessuna chiave API, nessun server. Usa la **Web Speech API** nativa di
Chrome/Edge per trascrivere il parlato in tempo reale, con momenti chiave,
appunti ed esportazione in `.txt` / `.md`.

---

## ✨ Funzionalità

- **Trascrizione live** con risultati parziali in tempo reale
- **Multilingua**: Italiano, Inglese (US/UK), Spagnolo, Francese, Tedesco
- **Riavvio automatico** dopo pause e silenzi (la call non si "perde")
- **⭐ Momenti chiave**: segna al volo i punti importanti (tasto `M`)
- **📝 Appunti** liberi accanto alla trascrizione
- **Timer** di durata della sessione + conteggio parole/interventi
- **Esportazione** in Markdown o testo, oppure copia tutto
- **Salvataggio automatico** in locale (riprende dopo un refresh)
- **Tema chiaro/scuro**
- **Scorciatoie**: `Ctrl/Cmd + Spazio` avvia/pausa · `M` segna momento

---

## 🚀 Come si usa

1. Apri l'app su **Google Chrome** o **Microsoft Edge** (aggiornati).
   - Puoi aprire direttamente `index.html`, oppure servirla (vedi sotto).
2. Seleziona la **lingua** della call.
3. Premi **Avvia** e concedi l'accesso al **microfono**.
4. Durante la call premi **“+ Segna”** (o `M`) sui punti importanti.
5. A fine call premi **Stop** ed **esporta** in `.md` / `.txt`.

### Servire l'app in locale (consigliato)

Alcuni browser abilitano il microfono solo su `http(s)` o `localhost`, non su `file://`:

```bash
# con Python
python3 -m http.server 8000
# poi apri http://localhost:8000
```

---

## 🔊 Catturare l'audio della call: come funziona davvero

La Web Speech API del browser trascrive **dal microfono**. Questo significa:

| Scenario | Cosa viene trascritto |
|---|---|
| **Vivavoce / altoparlanti** | La tua voce **e** quella degli altri (il mic riprende l'audio dalle casse) ✅ |
| **Cuffie / auricolari** | Solo la **tua** voce ❌ (l'altro lato non passa dal microfono) |

### 💡 Catturare *entrambi* i lati anche con le cuffie

Per trascrivere sia te che gli altri interlocutori, instrada l'audio del PC verso
un **microfono virtuale**, così il browser lo "sente" come input:

- **Windows** → [VB-CABLE](https://vb-audio.com/Cable/) (Virtual Audio Cable)
- **macOS** → [BlackHole](https://existential.audio/blackhole/) o [Loopback](https://rogueamoeba.com/loopback/)
- **Linux** → `PulseAudio` / `PipeWire` con un *null sink* + *loopback*

Imposta poi quel dispositivo virtuale come microfono predefinito del browser.

> **In arrivo (opzione avanzata):** un backend con Whisper/Deepgram per catturare
> direttamente l'audio della scheda condivisa e ottenere una precisione maggiore,
> senza cavi virtuali. Vedi [ROADMAP.md](ROADMAP.md).

---

## 🗂️ Struttura del progetto

```
.
├── index.html   # interfaccia
├── styles.css   # stile (tema chiaro/scuro)
├── app.js       # logica: Web Speech API, sessione, esport, storage
├── ROADMAP.md   # prossimi passi (backend Whisper, diarizzazione, ecc.)
└── README.md
```

Nessuna dipendenza, nessun build step: è tutto vanilla JavaScript.

---

## 🔒 Privacy

Trascrizione, momenti chiave e appunti restano **nel tuo browser**
(`localStorage`). Nulla viene inviato a un nostro server — non esiste un server.
Nota tecnica: la Web Speech API di Chrome può elaborare l'audio tramite i servizi
di riconoscimento vocale del browser. Per un uso 100% offline sarà disponibile
l'opzione con modello locale (vedi roadmap).

---

## 🌐 Compatibilità

| Browser | Supporto |
|---|---|
| Chrome (desktop) | ✅ Pieno |
| Edge (desktop) | ✅ Pieno |
| Safari | ⚠️ Parziale/instabile |
| Firefox | ❌ Web Speech API non disponibile |

---

## 📄 Licenza

MIT — vedi [LICENSE](LICENSE).
