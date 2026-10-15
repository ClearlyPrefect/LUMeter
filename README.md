# LuMeter Web

EBU R128 / ITU-R BS.1770-4 Loudness-Meter (Stereo) im Browser. Eine Codebasis
fuer Windows und Android, offline-faehig, auf Android als App installierbar.

Einrichtung und Testplan: siehe Dokument „LuMeter Web — Konzept und Testanleitung“.

## Dateien
| Datei | Inhalt |
| --- | --- |
| `index.html` | UI-Struktur |
| `styles.css` | Styling, Telefon-Layout |
| `app.js` | Audio-Setup, M/S/I/LRA, Gating, Referenz, Pause, Einstellungen, Wake Lock |
| `r128-processor.js` | AudioWorklet: K-Weighting, Sample-Peak, True-Peak (4x) |
| `sw.js` | Service Worker: Offline-Betrieb (Netz zuerst, Cache als Rueckfall) |
| `manifest.webmanifest`, `icon-*.png` | Installation als App |

## Kurzstart
```
py -m http.server 8000      # oder: npx serve -l 8000
```
Dann `http://localhost:8000` in Chrome/Edge. Am Telefon nur ueber HTTPS
(GitHub Pages oder `cloudflared tunnel --url http://localhost:8000`).

## Messung
- Referenz frei waehlbar (0,5-LU-Schritte), Anzeige in LU relativ dazu.
  Beispiel: +9 LU → −14 LUFS wird als 0 LU angezeigt.
- K-Weighting-Koeffizienten werden aus der tatsaechlichen Abtastrate berechnet;
  bei 48 kHz identisch mit den Referenzwerten der Spezifikation.
- Gepruefte Sollwerte: 1 kHz, −23 dBFS auf L+R → −23,0 LUFS;
  997 Hz, 0 dBFS nur L → −3,01 LUFS (44,1 / 48 / 96 kHz).

## Bekannte Grenzen
- Integrated/LRA halten alle Bloecke im Speicher; fuer mehrstuendige Laeufe
  waere ein Histogramm sparsamer.
- Bei neuem Release `CACHE` in `sw.js` hochzaehlen.
