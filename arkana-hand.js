/**
 * ARKANA HAND — AR Card Materialization Module
 * Integrates into Radio Arkana's index.html
 *
 * Dependencies (already in global scope from index.html):
 *   - getQuantumByte()
 *   - DECKS, currentDeck, currentLang, CARD_SLUGS_ES, CARDS
 *   - LANG_CONFIG
 *
 * External CDN loaded by this module:
 *   - MediaPipe Hands
 */

(function () {
  'use strict';

  // ── CONSTANTS ──────────────────────────────────────────────────────────────
  const MAX_CARDS      = 4;
  const PINCH_THRESH   = 0.07;   // normalized distance to trigger pinch
  const PINCH_COOLDOWN = 900;    // ms between pinch events
  const OPEN_PALM_FRAMES = 28;   // frames of open palm to trigger reset
  const CARD_W_RATIO   = 0.22;   // card width as fraction of canvas width
  const CARD_APPEAR_MS = 480;
  const CARD_RESET_MS  = 320;

  // ── STATE ──────────────────────────────────────────────────────────────────
  let handStream        = null;
  let handCamera        = null;   // MediaPipe Camera instance
  let hands             = null;   // MediaPipe Hands instance
  let rafId             = null;
  let activeCards       = [];     // { x, y, cardIndex, slug, name, img, age, opacity, state }
  let lastPinchTime     = 0;
  let openPalmCounter   = 0;
  let isResetting       = false;
  let mpReady           = false;
  let handVisible       = false;

  // preloaded card images cache
  const imgCache = {};

  // ── DOM INJECTION ──────────────────────────────────────────────────────────
  function injectHTML() {
    // ── BUTTON in controls-left ────────────────────────────────────────────
    const ctrlLeft = document.querySelector('.controls-left');
    if (ctrlLeft) {
      const sep = document.createElement('span');
      sep.className = 'ctrl-sep';
      const btn = document.createElement('button');
      btn.className  = 'layer-btn';
      btn.id         = 'btnHand';
      btn.title      = 'Arkana Hand · Materializar cartas con gestos';
      btn.setAttribute('aria-label', 'Arkana Hand');
      btn.innerHTML  = `
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
             stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M18 11V6a2 2 0 0 0-4 0v5"/>
          <path d="M14 10V4a2 2 0 0 0-4 0v6"/>
          <path d="M10 10.5V6a2 2 0 0 0-4 0v8"/>
          <path d="M6 14a4 4 0 0 0 4 4h4a4 4 0 0 0 4-4v-2.5"/>
        </svg>`;
      btn.addEventListener('click', openHandModal);
      ctrlLeft.appendChild(sep);
      ctrlLeft.appendChild(btn);
    }

    // ── MODAL ──────────────────────────────────────────────────────────────
    const modal = document.createElement('div');
    modal.id = 'handModal';
    modal.innerHTML = `
      <div id="handViewport">
        <video id="handVideo" autoplay playsinline muted></video>
        <canvas id="handCanvas"></canvas>

        <div id="handHUD">
          <div id="handWatermark">ARKANA HAND</div>

          <div id="handStatus">
            <span id="handStatusDot"></span>
            <span id="handStatusText">Iniciando…</span>
          </div>

          <div id="handCardCount">
            <span id="handCountNum">0</span><span id="handCountMax">/4</span>
          </div>

          <div id="handGestureHint" class="hint-hidden">
            <span id="handGestureIcon">✦</span>
            <span id="handGestureLabel">Pinch para materializar</span>
          </div>

          <div id="handResetHint" class="hint-hidden">Palma abierta · resetear</div>
        </div>

        <div id="handPalmProgress">
          <svg viewBox="0 0 36 36" id="handPalmSvg">
            <circle cx="18" cy="18" r="15.9"
              fill="none" stroke="rgba(230,48,48,0.2)" stroke-width="2"/>
            <circle cx="18" cy="18" r="15.9" id="handPalmArc"
              fill="none" stroke="#e63030" stroke-width="2"
              stroke-dasharray="0 100" stroke-linecap="round"
              transform="rotate(-90 18 18)"/>
          </svg>
        </div>
      </div>

      <div id="handControls">
        <button id="handCloseBtn">✕ Cerrar</button>
        <div id="handCardPips">
          <span class="pip" id="pip0"></span>
          <span class="pip" id="pip1"></span>
          <span class="pip" id="pip2"></span>
          <span class="pip" id="pip3"></span>
        </div>
        <button id="handResetBtn">↺ Reset</button>
      </div>
    `;
    document.body.appendChild(modal);

    // ── STYLES ─────────────────────────────────────────────────────────────
    const style = document.createElement('style');
    style.textContent = `
      #handModal {
        display: none;
        position: fixed; inset: 0; z-index: 800;
        background: #000;
        flex-direction: column;
        font-family: 'Space Mono', monospace;
      }
      #handModal.active { display: flex; }

      #handViewport {
        position: relative; flex: 1; overflow: hidden; background: #000;
        touch-action: none;
      }
      #handVideo {
        width: 100%; height: 100%;
        object-fit: cover; display: block;
        transform: scaleX(-1);
      }
      #handCanvas {
        position: absolute; inset: 0;
        width: 100%; height: 100%;
        pointer-events: none;
      }

      /* ── HUD ── */
      #handHUD { position: absolute; inset: 0; pointer-events: none; }

      #handWatermark {
        position: absolute;
        top: max(18px, env(safe-area-inset-top) + 10px);
        left: 18px;
        font-size: 8px; letter-spacing: 0.28em;
        text-transform: uppercase;
        color: rgba(230,48,48,0.8);
        text-shadow: 0 1px 6px rgba(0,0,0,0.9);
      }

      #handStatus {
        position: absolute;
        top: max(18px, env(safe-area-inset-top) + 10px);
        right: 18px;
        display: flex; align-items: center; gap: 7px;
        font-size: 8px; letter-spacing: 0.2em; text-transform: uppercase;
        color: rgba(240,236,228,0.7);
        text-shadow: 0 1px 4px rgba(0,0,0,0.9);
      }
      #handStatusDot {
        width: 6px; height: 6px; border-radius: 50%;
        background: #555; flex-shrink: 0;
        transition: background 0.3s, box-shadow 0.3s;
      }
      #handStatusDot.ready {
        background: #22c55e;
        box-shadow: 0 0 8px #22c55e;
        animation: handPulse 1.8s infinite;
      }
      #handStatusDot.hand {
        background: #e63030;
        box-shadow: 0 0 8px #e63030;
        animation: handPulse 1s infinite;
      }
      @keyframes handPulse { 0%,100%{opacity:1;}50%{opacity:0.4;} }

      #handCardCount {
        position: absolute;
        bottom: 28px; left: 50%; transform: translateX(-50%);
        font-size: 11px; letter-spacing: 0.2em;
        color: rgba(240,236,228,0.5);
      }
      #handCountNum { color: #e63030; font-size: 18px; }
      #handCountNum.full { animation: handShake 0.35s ease; }
      @keyframes handShake {
        0%,100%{transform:translateX(0);}
        25%{transform:translateX(-3px);}
        75%{transform:translateX(3px);}
      }

      #handGestureHint {
        position: absolute;
        bottom: 58px; left: 50%; transform: translateX(-50%);
        display: flex; align-items: center; gap: 8px;
        font-size: 9px; letter-spacing: 0.18em; text-transform: uppercase;
        color: rgba(240,236,228,0.5);
        transition: opacity 0.4s;
        white-space: nowrap;
      }
      #handGestureHint.hint-hidden { opacity: 0; }
      #handGestureHint.hint-visible { opacity: 1; }
      #handGestureIcon { color: #e63030; font-size: 11px; }

      #handResetHint {
        position: absolute;
        top: 50%; left: 50%;
        transform: translate(-50%, -50%);
        font-size: 8px; letter-spacing: 0.22em; text-transform: uppercase;
        color: rgba(230,48,48,0.7);
        text-shadow: 0 1px 4px rgba(0,0,0,0.9);
        transition: opacity 0.3s;
        pointer-events: none;
      }
      #handResetHint.hint-hidden { opacity: 0; }
      #handResetHint.hint-visible { opacity: 1; }

      /* ── PALM PROGRESS RING ── */
      #handPalmProgress {
        position: absolute;
        bottom: 90px; left: 50%;
        transform: translateX(-50%);
        width: 40px; height: 40px;
        opacity: 0; transition: opacity 0.3s;
        pointer-events: none;
      }
      #handPalmProgress.visible { opacity: 1; }
      #handPalmSvg { width: 100%; height: 100%; }

      /* ── CONTROLS BAR ── */
      #handControls {
        background: #080808;
        padding: 14px 24px;
        padding-bottom: max(14px, env(safe-area-inset-bottom));
        display: flex; align-items: center; justify-content: space-between;
        border-top: 1px solid #1a1a1a;
      }
      #handCloseBtn, #handResetBtn {
        background: transparent;
        border: 1px solid #2a2a2a;
        color: #666;
        font-family: 'Space Mono', monospace;
        font-size: 8px; letter-spacing: 0.2em; text-transform: uppercase;
        padding: 9px 14px; cursor: pointer;
        transition: all 0.2s;
        min-width: 72px; text-align: center;
      }
      #handCloseBtn:hover, #handResetBtn:hover {
        border-color: #e63030; color: #e63030;
      }
      #handResetBtn:active { transform: scale(0.96); }

      /* ── PIPS ── */
      #handCardPips {
        display: flex; gap: 8px; align-items: center;
      }
      .pip {
        width: 8px; height: 8px; border-radius: 50%;
        background: #1e1e1e;
        border: 1px solid #2a2a2a;
        transition: background 0.3s, border-color 0.3s, box-shadow 0.3s;
      }
      .pip.filled {
        background: #e63030;
        border-color: #e63030;
        box-shadow: 0 0 6px rgba(230,48,48,0.5);
      }

      /* ── CARD LABELS rendered in canvas (no DOM needed) ── */
    `;
    document.head.appendChild(style);

    // Wire buttons
    document.getElementById('handCloseBtn').addEventListener('click', closeHandModal);
    document.getElementById('handResetBtn').addEventListener('click', resetCards);
  }

  // ── OPEN / CLOSE ───────────────────────────────────────────────────────────
  async function openHandModal() {
    document.getElementById('handModal').classList.add('active');
    setStatus('loading', 'Iniciando…');
    await startHandStream();
    if (!mpReady) await loadMediaPipe();
    updatePips();
  }

  function closeHandModal() {
    stopHandSession();
    document.getElementById('handModal').classList.remove('active');
  }

  async function startHandStream() {
    if (handStream) { handStream.getTracks().forEach(t => t.stop()); handStream = null; }
    try {
      handStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false
      });
      document.getElementById('handVideo').srcObject = handStream;
    } catch (e) {
      setStatus('error', 'Sin cámara');
    }
  }

  function stopHandSession() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    if (handCamera) { try { handCamera.stop(); } catch(e) {} handCamera = null; }
    if (handStream) { handStream.getTracks().forEach(t => t.stop()); handStream = null; }
    document.getElementById('handVideo').srcObject = null;
    activeCards = [];
    openPalmCounter = 0;
    isResetting = false;
    mpReady = false;
    hands = null;
  }

  // ── MEDIAPIPE LOADER ───────────────────────────────────────────────────────
  async function loadMediaPipe() {
    return new Promise((resolve, reject) => {
      // Load hands script
      const script1 = document.createElement('script');
      script1.src = 'https://cdn.jsdelivr.net/npm/@mediapipe/hands/hands.js';
      script1.crossOrigin = 'anonymous';

      const script2 = document.createElement('script');
      script2.src = 'https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils/camera_utils.js';
      script2.crossOrigin = 'anonymous';

      script1.onload = () => {
        document.head.appendChild(script2);
      };
      script2.onload = () => {
        initMediaPipe().then(resolve).catch(reject);
      };
      script1.onerror = script2.onerror = reject;
      document.head.appendChild(script1);
    });
  }

  async function initMediaPipe() {
    const video  = document.getElementById('handVideo');
    const canvas = document.getElementById('handCanvas');

    hands = new window.Hands({
      locateFile: (file) =>
        `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`
    });

    hands.setOptions({
      maxNumHands:          1,
      modelComplexity:      1,
      minDetectionConfidence: 0.75,
      minTrackingConfidence:  0.65
    });

    hands.onResults(onHandResults);

    handCamera = new window.Camera(video, {
      onFrame: async () => {
        if (hands) await hands.send({ image: video });
        drawFrame();
      },
      width: 1280, height: 720
    });

    await handCamera.start();
    mpReady = true;
    setStatus('ready', 'Listo');
    document.getElementById('handGestureHint').classList.replace('hint-hidden', 'hint-visible');
  }

  // ── MEDIAPIPE RESULTS ──────────────────────────────────────────────────────
  let lastLandmarks = null;

  function onHandResults(results) {
    if (!results.multiHandLandmarks || results.multiHandLandmarks.length === 0) {
      lastLandmarks = null;
      handVisible   = false;
      openPalmCounter = 0;
      setStatus('ready', 'Listo');
      updatePalmProgress(0);
      document.getElementById('handResetHint').classList.replace('hint-visible','hint-hidden');
      return;
    }

    handVisible    = true;
    lastLandmarks  = results.multiHandLandmarks[0];
    setStatus('hand', 'Mano detectada');

    const pinching   = detectPinch(lastLandmarks);
    const openPalm   = detectOpenPalm(lastLandmarks);
    const now        = Date.now();

    // ── PINCH → materialise card ──
    if (pinching && !isResetting && activeCards.length < MAX_CARDS && (now - lastPinchTime) > PINCH_COOLDOWN) {
      lastPinchTime = now;
      const canvas  = document.getElementById('handCanvas');
      // Use index finger tip position (mirrored)
      const lm = lastLandmarks[8];
      const x  = (1 - lm.x) * canvas.width;
      const y  = lm.y * canvas.height;
      spawnCard(x, y);
    }

    // ── OPEN PALM → reset counter ──
    if (openPalm && activeCards.length > 0) {
      openPalmCounter++;
      const progress = openPalmCounter / OPEN_PALM_FRAMES;
      updatePalmProgress(progress);
      document.getElementById('handResetHint').classList.replace('hint-hidden','hint-visible');
      if (openPalmCounter >= OPEN_PALM_FRAMES) {
        openPalmCounter = 0;
        updatePalmProgress(0);
        resetCards();
      }
    } else {
      openPalmCounter = Math.max(0, openPalmCounter - 2);
      updatePalmProgress(openPalmCounter / OPEN_PALM_FRAMES);
      if (openPalmCounter === 0) {
        document.getElementById('handResetHint').classList.replace('hint-visible','hint-hidden');
      }
    }
  }

  // ── GESTURE DETECTION ──────────────────────────────────────────────────────
  function dist2D(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function detectPinch(lm) {
    // Thumb tip (4) ↔ Index tip (8)
    return dist2D(lm[4], lm[8]) < PINCH_THRESH;
  }

  function detectOpenPalm(lm) {
    // All 4 fingers extended: tip y < pip y (in normalized coords, y increases downward)
    // Index=8>6, Middle=12>10, Ring=16>14, Pinky=20>18
    const fingers = [[8,6],[12,10],[16,14],[20,18]];
    return fingers.every(([tip, pip]) => lm[tip].y < lm[pip].y);
  }

  // ── SPAWN CARD ─────────────────────────────────────────────────────────────
  function spawnCard(x, y) {
    if (typeof window.getQuantumByte !== 'function') return;

    const deck    = window.currentDeck || 'marsella';
    const lang    = window.currentLang || 'es';
    const deckDef = window.DECKS[deck];

    // Draw unique card (not already on screen)
    let idx, attempts = 0;
    do {
      idx = window.getQuantumByte() % 22;
      attempts++;
    } while (activeCards.some(c => c.cardIndex === idx) && attempts < 44);

    const name = deckDef[lang][idx];
    const slug = deckDef.slugs[idx];
    const src  = `${deckDef.path}/thumb/${slug}.jpg`;

    // Preload image
    let img = imgCache[src];
    if (!img) {
      img = new Image();
      img.src = src;
      imgCache[src] = img;
    }

    const card = {
      x, y,
      cardIndex: idx,
      slug, name,
      img,
      age:     0,
      opacity: 0,
      state:   'appearing',   // appearing | visible | disappearing
      spawnTime: Date.now()
    };

    activeCards.push(card);
    updatePips();
    updateCountDisplay();

    // TTS — speak card name
    speakCard(name);

    // Haptic
    if (navigator.vibrate) navigator.vibrate([30, 20, 30]);
  }

  function speakCard(name) {
    const lang   = window.currentLang || 'es';
    const cfg    = window.LANG_CONFIG?.[lang] || { lang: 'es-ES' };
    const vol    = parseFloat(document.getElementById('volume')?.value ?? 0.8);
    window.speechSynthesis.cancel();
    const utt    = new SpeechSynthesisUtterance(name);
    utt.lang     = cfg.lang;
    utt.rate     = 0.75;
    utt.pitch    = 1.0;
    utt.volume   = vol;
    window.speechSynthesis.speak(utt);
  }

  // ── RESET ──────────────────────────────────────────────────────────────────
  function resetCards() {
    if (isResetting || activeCards.length === 0) return;
    isResetting = true;
    activeCards.forEach(c => { c.state = 'disappearing'; });
    setTimeout(() => {
      activeCards   = [];
      isResetting   = false;
      openPalmCounter = 0;
      updatePips();
      updateCountDisplay();
    }, CARD_RESET_MS + 80);
  }

  // ── DRAW FRAME ─────────────────────────────────────────────────────────────
  function drawFrame() {
    const canvas  = document.getElementById('handCanvas');
    const video   = document.getElementById('handVideo');
    if (!canvas || !video) return;

    // Resize canvas to match video display size
    if (canvas.width !== canvas.offsetWidth || canvas.height !== canvas.offsetHeight) {
      canvas.width  = canvas.offsetWidth  * devicePixelRatio;
      canvas.height = canvas.offsetHeight * devicePixelRatio;
    }

    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const now     = Date.now();
    const cardW   = canvas.width  * CARD_W_RATIO;
    const cardH   = cardW * 1.75;

    // Update and draw cards
    activeCards = activeCards.filter(card => {
      const elapsed = now - card.spawnTime;

      if (card.state === 'appearing') {
        card.opacity = Math.min(1, elapsed / CARD_APPEAR_MS);
        if (card.opacity >= 1) card.state = 'visible';
      } else if (card.state === 'disappearing') {
        card.opacity = Math.max(0, 1 - (elapsed - card._disappearStart) / CARD_RESET_MS);
        if (card.opacity <= 0) return false; // remove
      }

      if (card.state === 'disappearing' && card._disappearStart === undefined) {
        card._disappearStart = now;
      }

      drawCard(ctx, card, cardW, cardH);
      return true;
    });

    // Draw hand skeleton overlay (subtle)
    if (lastLandmarks && handVisible) {
      drawHandOverlay(ctx, canvas.width, canvas.height);
    }
  }

  function drawCard(ctx, card, cardW, cardH) {
    const x   = card.x - cardW / 2;
    const y   = card.y - cardH / 2;
    const r   = 8;

    ctx.save();
    ctx.globalAlpha = card.opacity;

    // Scale spring on appear
    let scale = 1;
    if (card.state === 'appearing') {
      scale = 0.6 + 0.4 * easeOutBack(card.opacity);
    }
    ctx.translate(card.x, card.y);
    ctx.scale(scale, scale);
    ctx.translate(-card.x, -card.y);

    // Shadow / glow
    ctx.shadowColor  = 'rgba(230,48,48,0.45)';
    ctx.shadowBlur   = 22 * card.opacity;
    ctx.shadowOffsetY = 4;

    // Card background
    ctx.beginPath();
    roundRect(ctx, x, y, cardW, cardH, r);
    ctx.fillStyle = '#0d0d0d';
    ctx.fill();

    // Border
    ctx.strokeStyle = `rgba(230,48,48,${0.6 * card.opacity})`;
    ctx.lineWidth   = 1.5;
    ctx.stroke();

    ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;

    // Card image
    if (card.img && card.img.complete && card.img.naturalWidth > 0) {
      ctx.save();
      ctx.beginPath();
      roundRect(ctx, x + 4, y + 4, cardW - 8, cardH - 8, r - 2);
      ctx.clip();
      ctx.drawImage(card.img, x + 4, y + 4, cardW - 8, cardH - 8);
      ctx.restore();
    } else {
      // Placeholder
      ctx.fillStyle = '#1a0a0a';
      ctx.beginPath();
      roundRect(ctx, x + 4, y + 4, cardW - 8, cardH - 8, r - 2);
      ctx.fill();
    }

    // Gradient overlay at bottom for label
    const gradH = cardH * 0.32;
    const grad  = ctx.createLinearGradient(0, y + cardH - gradH, 0, y + cardH);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(0.5, 'rgba(0,0,0,0.7)');
    grad.addColorStop(1, 'rgba(0,0,0,0.92)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    roundRect(ctx, x + 4, y + cardH - gradH, cardW - 8, gradH, 0);
    ctx.fill();

    // Card name label
    const fontSize = Math.max(9, cardW * 0.095);
    ctx.font        = `${fontSize}px 'Bebas Neue', sans-serif`;
    ctx.fillStyle   = '#f0ece4';
    ctx.textAlign   = 'center';
    ctx.textBaseline = 'bottom';
    ctx.shadowColor = 'rgba(0,0,0,0.9)';
    ctx.shadowBlur  = 6;

    // Word-wrap name into two lines if needed
    const maxW  = cardW - 16;
    const words = card.name.split(' ');
    const lines = [];
    let line    = '';
    words.forEach(w => {
      const test = line ? line + ' ' + w : w;
      if (ctx.measureText(test).width > maxW && line) {
        lines.push(line); line = w;
      } else { line = test; }
    });
    if (line) lines.push(line);

    const lineH   = fontSize * 1.15;
    const startY  = y + cardH - 8;
    lines.slice(-2).reverse().forEach((l, i) => {
      ctx.fillText(l, x + cardW / 2, startY - i * lineH);
    });

    ctx.shadowBlur = 0;
    ctx.restore();
  }

  function drawHandOverlay(ctx, W, H) {
    const lm = lastLandmarks;
    // Connections (simplified palm)
    const connections = [
      [0,1],[1,2],[2,3],[3,4],
      [0,5],[5,6],[6,7],[7,8],
      [5,9],[9,10],[10,11],[11,12],
      [9,13],[13,14],[14,15],[15,16],
      [13,17],[17,18],[18,19],[19,20],[0,17]
    ];

    ctx.save();
    ctx.strokeStyle = 'rgba(230,48,48,0.25)';
    ctx.lineWidth   = 1;
    connections.forEach(([a, b]) => {
      ctx.beginPath();
      ctx.moveTo((1 - lm[a].x) * W, lm[a].y * H);
      ctx.lineTo((1 - lm[b].x) * W, lm[b].y * H);
      ctx.stroke();
    });

    // Key points
    [4, 8].forEach(i => {
      ctx.beginPath();
      ctx.arc((1 - lm[i].x) * W, lm[i].y * H, 4, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(230,48,48,0.6)';
      ctx.fill();
    });
    ctx.restore();
  }

  // ── UI HELPERS ─────────────────────────────────────────────────────────────
  function setStatus(state, text) {
    const dot  = document.getElementById('handStatusDot');
    const label = document.getElementById('handStatusText');
    if (!dot || !label) return;
    dot.className  = state === 'ready' ? 'ready' : state === 'hand' ? 'hand' : '';
    label.textContent = text;
  }

  function updatePips() {
    for (let i = 0; i < 4; i++) {
      const pip = document.getElementById(`pip${i}`);
      if (pip) pip.classList.toggle('filled', i < activeCards.length);
    }
    const hint = document.getElementById('handGestureHint');
    if (hint) {
      if (activeCards.length >= MAX_CARDS) {
        document.getElementById('handGestureLabel').textContent = 'Palma abierta para resetear';
        document.getElementById('handGestureIcon').textContent  = '◻';
      } else {
        document.getElementById('handGestureLabel').textContent = 'Pinch para materializar';
        document.getElementById('handGestureIcon').textContent  = '✦';
      }
    }
  }

  function updateCountDisplay() {
    const num = document.getElementById('handCountNum');
    if (!num) return;
    num.textContent = activeCards.length;
    if (activeCards.length >= MAX_CARDS) {
      num.classList.add('full');
      setTimeout(() => num.classList.remove('full'), 400);
    }
  }

  function updatePalmProgress(t) {
    const wrap = document.getElementById('handPalmProgress');
    const arc  = document.getElementById('handPalmArc');
    if (!wrap || !arc) return;
    wrap.classList.toggle('visible', t > 0.05);
    const dash = (t * 100).toFixed(1);
    arc.setAttribute('stroke-dasharray', `${dash} ${100 - parseFloat(dash)}`);
  }

  // ── MATH HELPERS ──────────────────────────────────────────────────────────
  function easeOutBack(t) {
    const c1 = 1.70158, c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  // ── INIT ───────────────────────────────────────────────────────────────────
  function init() {
    injectHTML();
  }

  // Wait for DOM
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
