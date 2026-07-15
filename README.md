# 🎙️ CallScribe

**Trascrizione in tempo reale delle call (Teams, Meet, Zoom…) in italiano e inglese.**
Prendi appunti durante le riunioni senza perderti le cose importanti.

CallScribe è una web app leggera che gira **interamente nel tuo browser**: nessun
account, nessuna chiave API, nessun server. Usa la **Web Speech API** nativa di
Chrome/Edge per trascrivere il parlato in tempo reale, con momenti chiave,
appunti ed esportazione in `.txt` / `.md`.

---

## ✨ Funzionalità

- **Due sorgenti audio combinate**:
  - 🎤 **Microfono** → la tua voce, via Web Speech API (istantanea)
  - 🔊 **Audio della call** → la voce degli altri, catturando l'audio della
    scheda condivisa e trascrivendolo con **Whisper in locale** — funziona
    **anche con le cuffie, senza cavi virtuali e senza chiavi API**
- **🌐 Traduzione in tempo reale** (locale): traduci la call — es. una riunione
  in **inglese** mostrata anche in **italiano** sotto ogni frase — senza chiavi
  né server (modelli Helsinki-NLP *opus-mt*)
- **Multilingua**: Italiano, Inglese (US/UK), Spagnolo, Francese, Tedesco
- **Riavvio automatico** dopo pause e silenzi (la call non si "perde")
- **⭐ Momenti chiave**: segna al volo i punti importanti (tasto `M`)
- **📝 Appunti** liberi accanto alla trascrizione
- **Timer** di durata della sessione + conteggio parole/interventi
- **Esportazione** in Markdown o testo (con etichetta di chi parla), o copia tutto
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

## 🔊 Catturare l'audio della call (anche con le cuffie, senza cavi)

CallScribe usa **due sorgenti** che puoi attivare insieme:

| Sorgente | Cosa trascrive | Tecnologia |
|---|---|---|
| 🎤 **Microfono** (pulsante *Avvia*) | La **tua** voce | Web Speech API (istantanea) |
| 🔊 **Audio call** (pulsante *Trascrivi audio call*) | La voce **degli altri** | Whisper **in locale** nel browser |

### Come si usa con le cuffie

1. Premi **🔊 Trascrivi audio call**.
2. Il browser chiede *cosa condividere*: scegli la **scheda** (o la finestra)
   della tua call **e spunta “Condividi audio scheda”** (in basso a sinistra).
3. Al primo utilizzo viene scaricato il modello Whisper (~40–140 MB a seconda
   della scelta *Tiny / Base / Small*); poi resta **in cache** e parte subito.
4. Premi anche **Avvia** per trascrivere in contemporanea la tua voce dal microfono.

Nessun cavo virtuale, nessun account, nessuna chiave: l'audio della call viene
elaborato **interamente sul tuo dispositivo**.

> 💡 **Prestazioni:** con una GPU compatibile il browser usa **WebGPU** (veloce).
> Altrimenti gira su CPU (WASM): in quel caso scegli il modello **Tiny** per
> ridurre il ritardo. Consigliati **Chrome/Edge** aggiornati.

### Alternativa: microfono in vivavoce

Se preferisci non condividere lo schermo, metti la call in
**vivavoce/altoparlanti** e usa solo il microfono (*Avvia*): il mic riprenderà
sia te che gli altri dalle casse.

---

## 🌐 Traduzione in tempo reale

Per seguire una call in un'altra lingua nella tua:

1. Imposta **Lingua** = lingua parlata nella call (es. *English*).
2. Imposta **🌐 Traduci in** = la tua lingua (es. *Italiano*).
3. Avvia il microfono e/o l'audio della call: sotto ogni frase comparirà la
   **traduzione** (icona 🌐).

Al primo uso si scarica un piccolo modello di traduzione (~75 MB per coppia di
lingue), poi resta in cache. Tutto avviene **in locale**, nessun dato esce dal
dispositivo. Le traduzioni sono incluse anche nei file esportati.

> **Coppie supportate:** ogni lingua **↔ inglese**
> (en↔it, en↔es, en↔fr, en↔de). Le combinazioni senza inglese (es. it→fr)
> non sono ancora disponibili.

---

## 🗂️ Struttura del progetto

```
.
├── index.html          # interfaccia
├── styles.css          # stile (tema chiaro/scuro)
├── app.js              # logica: sorgenti audio, VAD, traduzione, esport, storage
├── whisper-worker.js   # Web Worker: Whisper locale (transformers.js) per l'audio call
├── translate-worker.js # Web Worker: traduzione locale (opus-mt) in tempo reale
├── ROADMAP.md          # prossimi passi (diarizzazione, riassunti, ecc.)
└── README.md
```

Nessun build step. L'unica dipendenza è **transformers.js**, caricato al volo da
CDN solo quando attivi l'audio della call (per il resto è tutto vanilla JS).

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
