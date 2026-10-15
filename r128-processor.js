// r128-processor.js
// AudioWorklet-Prozessor fuer EBU R128 / ITU-R BS.1770-4 (Stereo).
//
// Aufgabe: pro Kanal
//   - K-Weighting-Filterkaskade anwenden und alle 100 ms den mittleren
//     quadratischen Wert (mean square) posten,
//   - Sample-Peak (digitaler Spitzenwert) je Block ermitteln,
//   - True-Peak per 4-fach-Oversampling (Polyphasen-FIR nach BS.1770-4,
//     Annex 2) je Block ermitteln.
// Fenster- und Gating-Logik (M, S, I, LRA, Max) liegt im Main-Thread.
//
// `sampleRate` ist im AudioWorkletGlobalScope global. Die K-Weighting-
// Koeffizienten werden daraus zur Laufzeit berechnet – keine 48-kHz-Annahme.

// --- K-Weighting: Biquad-Koeffizienten --------------------------------------
// Bilineare Ableitung der BS.1770-Analogfilter (wie libebur128). Liefert bei
// 48 kHz exakt die Referenzkoeffizienten der Spezifikation und gilt fuer
// jede andere Rate.

// Stufe 1: High-Shelf (+4 dB oberhalb ~1,7 kHz, "Kopf-Effekt").
function shelfStage(fs) {
  const f0 = 1681.974450955533;
  const G = 3.999843853973347;
  const Q = 0.7071752369554196;
  const K = Math.tan((Math.PI * f0) / fs);
  const Vh = Math.pow(10, G / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  const a0 = 1 + K / Q + K * K;
  return {
    b0: (Vh + (Vb * K) / Q + K * K) / a0,
    b1: (2 * (K * K - Vh)) / a0,
    b2: (Vh - (Vb * K) / Q + K * K) / a0,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
}

// Stufe 2: Hochpass ~38 Hz (RLB). Zaehler laut Spezifikation unnormiert 1, -2, 1.
function highPassStage(fs) {
  const f0 = 38.13547087602444;
  const Q = 0.5003270373238773;
  const K = Math.tan((Math.PI * f0) / fs);
  const a0 = 1 + K / Q + K * K;
  return {
    b0: 1,
    b1: -2,
    b2: 1,
    a1: (2 * (K * K - 1)) / a0,
    a2: (1 - K / Q + K * K) / a0,
  };
}

// Biquad, Direct Form II transposed.
class Biquad {
  constructor(c) {
    this.b0 = c.b0; this.b1 = c.b1; this.b2 = c.b2;
    this.a1 = c.a1; this.a2 = c.a2;
    this.z1 = 0; this.z2 = 0;
  }
  process(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
  reset() { this.z1 = 0; this.z2 = 0; }
}

// --- True-Peak: 4x Polyphasen-Interpolator (BS.1770-4, Annex 2) ------------
// 48 Taps, aufgeteilt in 4 Phasen zu je 12 Koeffizienten.
const TP_PHASES = [
  new Float64Array([ 0.0017089843750,  0.0109863281250, -0.0196533203125,  0.0332031250000,
                    -0.0594482421875,  0.1373291015625,  0.9721679687500, -0.1022949218750,
                     0.0476074218750, -0.0266113281250,  0.0148925781250, -0.0083007812500]),
  new Float64Array([-0.0291748046875,  0.0292968750000, -0.0517578125000,  0.0891113281250,
                    -0.1665039062500,  0.4650878906250,  0.7797851562500, -0.2003173828125,
                     0.1015625000000, -0.0582275390625,  0.0330810546875, -0.0189208984375]),
  new Float64Array([-0.0189208984375,  0.0330810546875, -0.0582275390625,  0.1015625000000,
                    -0.2003173828125,  0.7797851562500,  0.4650878906250, -0.1665039062500,
                     0.0891113281250, -0.0517578125000,  0.0292968750000, -0.0291748046875]),
  new Float64Array([-0.0083007812500,  0.0148925781250, -0.0266113281250,  0.0476074218750,
                    -0.1022949218750,  0.9721679687500,  0.1373291015625, -0.0594482421875,
                     0.0332031250000, -0.0196533203125,  0.0109863281250,  0.0017089843750]),
];
const TP_TAPS = 12;

class TruePeak {
  constructor() {
    // Ringpuffer doppelt so lang, damit das Faltungsfenster ohne Modulo
    // zusammenhaengend gelesen werden kann.
    this.buf = new Float64Array(TP_TAPS * 2);
    this.pos = 0;
  }
  // Gibt den betragsmaessig groessten interpolierten Wert fuer dieses Sample zurueck.
  process(x) {
    this.buf[this.pos] = x;
    this.buf[this.pos + TP_TAPS] = x;
    // Fenster: aelteste ... neueste Sample = buf[pos+1 .. pos+TP_TAPS]
    const start = this.pos + 1;
    let max = 0;
    for (let p = 0; p < 4; p++) {
      const c = TP_PHASES[p];
      let acc = 0;
      for (let k = 0; k < TP_TAPS; k++) acc += c[k] * this.buf[start + k];
      const a = acc < 0 ? -acc : acc;
      if (a > max) max = a;
    }
    this.pos = (this.pos + 1) % TP_TAPS;
    return max;
  }
  reset() { this.buf.fill(0); this.pos = 0; }
}

// --- Prozessor --------------------------------------------------------------
class R128Processor extends AudioWorkletProcessor {
  constructor() {
    super();

    const s1 = shelfStage(sampleRate);
    const s2 = highPassStage(sampleRate);

    this.ch = [0, 1].map(() => ({
      shelf: new Biquad(s1),
      hp: new Biquad(s2),
      tp: new TruePeak(),
      sumSq: 0,
      peak: 0,
      truePeak: 0,
    }));

    this.blockSamples = Math.round(sampleRate * 0.1); // 100-ms-Bloecke
    this.counter = 0;
    this.running = true;

    this.port.onmessage = (e) => {
      if (e.data === 'reset') this.resetAll();
      else if (e.data === 'stop') this.running = false;
    };
  }

  resetAll() {
    for (const c of this.ch) {
      c.shelf.reset(); c.hp.reset(); c.tp.reset();
      c.sumSq = 0; c.peak = 0; c.truePeak = 0;
    }
    this.counter = 0;
  }

  process(inputs) {
    if (!this.running) return false;
    const input = inputs[0];
    if (!input || input.length === 0) return true;

    // Mono-Quelle auf beide Kanaele spiegeln (konsistente Stereo-Summierung).
    const src = [input[0], input.length > 1 ? input[1] : input[0]];
    const n = src[0].length;

    for (let i = 0; i < n; i++) {
      for (let c = 0; c < 2; c++) {
        const st = this.ch[c];
        const x = src[c][i];

        const ax = x < 0 ? -x : x;
        if (ax > st.peak) st.peak = ax;

        const tp = st.tp.process(x);
        if (tp > st.truePeak) st.truePeak = tp;

        const y = st.hp.process(st.shelf.process(x));
        st.sumSq += y * y;
      }

      if (++this.counter >= this.blockSamples) {
        const inv = 1 / this.counter;
        const [L, R] = this.ch;
        this.port.postMessage({
          msL: L.sumSq * inv,
          msR: R.sumSq * inv,
          // Kanal-Maximum reicht fuer die Anzeige.
          peak: Math.max(L.peak, R.peak),
          // True-Peak kann den Sample-Peak nicht unterschreiten.
          truePeak: Math.max(L.truePeak, R.truePeak, L.peak, R.peak),
        });
        this.counter = 0;
        for (const c of this.ch) { c.sumSq = 0; c.peak = 0; c.truePeak = 0; }
      }
    }
    return true;
  }
}

registerProcessor('r128-processor', R128Processor);
