/**
 * ARKANA HAND — AR Card Materialization Module v2
 * Integrates into Radio Arkana's index.html
 *
 * Changes v2:
 *   - No card name labels drawn on cards
 *   - Drag: middle+ring fingers together → selects card → move hand → open fingers releases
 *   - Capture: ⊙ button composites video + AR cards → JPEG download
 *   - Camera flip: toggle front / rear camera
 *
 * Dependencies (global scope from index.html):
 *   getQuantumByte(), DECKS, currentDeck, currentLang, LANG_CONFIG
 */

(function () {
  'use strict';

  // ── CONSTANTS ──────────────────────────────────────────────────────────────
  const MAX_CARDS        = 4;
  const PINCH_THRESH     = 0.07;
  const PINCH_COOLDOWN   = 900;
  const DRAG_THRESH      = 0.06;   // middle-ring tip distance to engage drag
  const DRAG_HIT_RADIUS  = 0.14;   // normalized radius for card hit-test
  const OPEN_PALM_FRAMES = 28;
  const CARD_W_RATIO     = 0.22;
  const CARD_APPEAR_MS   = 480;
  const CARD_RESET_MS    = 320;

  // ── STATE ──────────────────────────────────────────────────────────────────
  let handStream      = null;
  let handCamera      = null;
  let hands           = null;
  let mpReady         = false;
  let handVisible     = false;
  let facingMode      = 'user';

  let activeCards     = [];
  let lastPinchTime   = 0;
  let openPalmCounter = 0;
  let isResetting     = false;

  let dragCard        = null;
  let dragEngaged     = false;
  let lastDragNx      = 0;
  let lastDragNy      = 0;

  const imgCache = {};

  // ── DOM INJECTION ──────────────────────────────────────────────────────────
  function injectHTML() {
    const ctrlLeft = document.querySelector('.controls-left');
    if (ctrlLeft) {
      const sep = document.createElement('span');
      sep.className = 'ctrl-sep';
      const btn = document.createElement('button');
      btn.className = 'layer-btn';
      btn.id        = 'btnHand';
      btn.title     = 'Arkana Hand · Materializar cartas con gestos';
      btn.setAttribute('aria-label', 'Arkana Hand');
      btn.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor"
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

    const modal = document.createElement('div');
    modal.id = 'handModal';
    modal.innerHTML = `
      <div id="handViewport">
        <video id="handVideo" autoplay playsinline muted></video>
        <canvas id="handCanvas"></canvas>
        <canvas id="handCaptureCanvas" style="display:none"></canvas>
        <div id="handHUD">
          <div id="handWatermark">ARKANA HAND</div>
          <div id="handStatus">
            <span id="handStatusDot"></span>
            <span id="handStatusText">Iniciando\u2026</span>
          </div>
          <div id="handCardCount">
            <span id="handCountNum">0</span><span id="handCountMax">/4</span>
          </div>
          <div id="handGestureHint" class="hint-hidden">
            <span id="handGestureIcon">\u2726</span>
            <span id="handGestureLabel">Pinch para materializar</span>
          </div>
          <div id="handDragHint" class="hint-hidden">Medio+anular \u00b7 moviendo</div>
          <div id="handResetHint" class="hint-hidden">Palma abierta \u00b7 resetear</div>
        </div>
        <div id="handPalmProgress">
          <svg viewBox="0 0 36 36" id="handPalmSvg">
            <circle cx="18" cy="18" r="15.9" fill="none" stroke="rgba(230,48,48,0.2)" stroke-width="2"/>
            <circle cx="18" cy="18" r="15.9" id="handPalmArc" fill="none" stroke="#e63030"
              stroke-width="2" stroke-dasharray="0 100" stroke-linecap="round"
              transform="rotate(-90 18 18)"/>
          </svg>
        </div>
        <div id="handFlashOverlay"></div>
      </div>
      <div id="handControls">
        <button id="handCloseBtn">\u2715 Cerrar</button>
        <div id="handCardPips">
          <span class="pip" id="pip0"></span>
          <span class="pip" id="pip1"></span>
          <span class="pip" id="pip2"></span>
          <span class="pip" id="pip3"></span>
        </div>
        <div style="display:flex;gap:5px;">
          <button id="handCaptureBtn" title="Capturar escena AR">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="3"/>
              <path d="M20 7h-3.4L15 5H9L7.4 7H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h16
                       a1 1 0 0 0 1-1V8a1 1 0 0 0-1-1z"/>
            </svg>
          </button>
          <button id="handFlipBtn" title="Cambiar c\u00e1mara">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                 stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M1 4v6h6"/><path d="M3.51 15a9 9 0 1 0 .49-3.1"/>
            </svg>
          </button>
          <button id="handResetBtn" title="Reset cartas">\u21ba</button>
        </div>
      </div>`;
    document.body.appendChild(modal);

    const style = document.createElement('style');
    style.textContent = `
      #handModal {
        display:none; position:fixed; inset:0; z-index:800;
        background:#000; flex-direction:column;
        font-family:'Space Mono',monospace;
      }
      #handModal.active { display:flex; }

      #handViewport { position:relative; flex:1; overflow:hidden; background:#000; touch-action:none; }
      #handVideo    { width:100%; height:100%; object-fit:cover; display:block; }
      #handCanvas   { position:absolute; inset:0; width:100%; height:100%; pointer-events:none; }

      #handHUD { position:absolute; inset:0; pointer-events:none; }

      #handWatermark {
        position:absolute; top:max(18px,env(safe-area-inset-top) + 10px); left:18px;
        font-size:8px; letter-spacing:.28em; text-transform:uppercase;
        color:rgba(230,48,48,.8); text-shadow:0 1px 6px rgba(0,0,0,.9);
      }
      #handStatus {
        position:absolute; top:max(18px,env(safe-area-inset-top) + 10px); right:18px;
        display:flex; align-items:center; gap:7px;
        font-size:8px; letter-spacing:.2em; text-transform:uppercase;
        color:rgba(240,236,228,.7); text-shadow:0 1px 4px rgba(0,0,0,.9);
      }
      #handStatusDot {
        width:6px; height:6px; border-radius:50%; background:#555;
        flex-shrink:0; transition:background .3s,box-shadow .3s;
      }
      #handStatusDot.ready { background:#22c55e; box-shadow:0 0 8px #22c55e; animation:hPulse 1.8s infinite; }
      #handStatusDot.hand  { background:#e63030; box-shadow:0 0 8px #e63030; animation:hPulse 1s infinite; }
      #handStatusDot.drag  { background:#f59e0b; box-shadow:0 0 8px #f59e0b; animation:hPulse .7s infinite; }
      @keyframes hPulse { 0%,100%{opacity:1;}50%{opacity:.4;} }

      #handCardCount {
        position:absolute; bottom:28px; left:50%; transform:translateX(-50%);
        font-size:11px; letter-spacing:.2em; color:rgba(240,236,228,.5);
      }
      #handCountNum { color:#e63030; font-size:18px; }
      #handCountNum.full { animation:hShake .35s ease; }
      @keyframes hShake { 0%,100%{transform:translateX(0)} 25%{transform:translateX(-3px)} 75%{transform:translateX(3px)} }

      #handGestureHint,#handDragHint,#handResetHint {
        position:absolute; left:50%; transform:translateX(-50%);
        font-size:8px; letter-spacing:.18em; text-transform:uppercase;
        transition:opacity .4s; white-space:nowrap;
        text-shadow:0 1px 4px rgba(0,0,0,.9);
      }
      #handGestureHint { bottom:58px; display:flex; align-items:center; gap:8px; color:rgba(240,236,228,.5); }
      #handDragHint    { bottom:80px; color:rgba(245,158,11,.85); }
      #handResetHint   { top:50%; color:rgba(230,48,48,.7); }
      .hint-hidden  { opacity:0; pointer-events:none; }
      .hint-visible { opacity:1; }
      #handGestureIcon { color:#e63030; font-size:11px; }

      #handPalmProgress {
        position:absolute; bottom:90px; left:50%; transform:translateX(-50%);
        width:40px; height:40px; opacity:0; transition:opacity .3s; pointer-events:none;
      }
      #handPalmProgress.visible { opacity:1; }
      #handPalmSvg { width:100%; height:100%; }

      #handFlashOverlay {
        position:absolute; inset:0; background:#fff; opacity:0;
        pointer-events:none; transition:opacity .08s ease-in;
      }
      #handFlashOverlay.flash { opacity:.82; }

      #handControls {
        background:#080808; border-top:1px solid #1a1a1a;
        padding:12px 20px; padding-bottom:max(12px,env(safe-area-inset-bottom));
        display:flex; align-items:center; justify-content:space-between;
      }
      #handCloseBtn,#handResetBtn,#handCaptureBtn,#handFlipBtn {
        background:transparent; border:1px solid #2a2a2a; color:#666;
        font-family:'Space Mono',monospace;
        font-size:8px; letter-spacing:.18em; text-transform:uppercase;
        padding:8px 11px; cursor:pointer; transition:all .2s;
        display:flex; align-items:center; justify-content:center; gap:5px;
      }
      #handCloseBtn { min-width:68px; }
      #handCloseBtn:hover,#handResetBtn:hover,#handCaptureBtn:hover,#handFlipBtn:hover {
        border-color:#e63030; color:#e63030;
      }
      #handFlipBtn.rear { border-color:rgba(34,197,94,.45); color:#22c55e; }

      #handCardPips { display:flex; gap:7px; align-items:center; }
      .pip {
        width:8px; height:8px; border-radius:50%;
        background:#1e1e1e; border:1px solid #2a2a2a;
        transition:background .3s,border-color .3s,box-shadow .3s;
      }
      .pip.filled   { background:#e63030; border-color:#e63030; box-shadow:0 0 6px rgba(230,48,48,.5); }
      .pip.dragging { background:#f59e0b; border-color:#f59e0b; box-shadow:0 0 6px rgba(245,158,11,.5); }
    `;
    document.head.appendChild(style);

    document.getElementById('handCloseBtn').addEventListener('click', closeHandModal);
    document.getElementById('handResetBtn').addEventListener('click', resetCards);
    document.getElementById('handCaptureBtn').addEventListener('click', captureScene);
    document.getElementById('handFlipBtn').addEventListener('click', flipCamera);
  }

  // ── OPEN / CLOSE ───────────────────────────────────────────────────────────
  async function openHandModal() {
    document.getElementById('handModal').classList.add('active');
    setStatus('loading', 'Iniciando\u2026');
    await waitForCanvasSize();
    await startHandStream();
    if (!mpReady) await loadMediaPipe();
    updatePips();
    updateFlipBtn();
  }

  function closeHandModal() {
    stopHandSession();
    document.getElementById('handModal').classList.remove('active');
  }

  async function startHandStream() {
    if (handStream) { handStream.getTracks().forEach(t => t.stop()); handStream = null; }
    const video = document.getElementById('handVideo');
    // Mirror only for front camera
    video.style.transform = facingMode === 'user' ? 'scaleX(-1)' : 'scaleX(1)';
    try {
      handStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false
      });
      video.srcObject = handStream;
    } catch (e) {
      try {
        handStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        video.srcObject = handStream;
      } catch (err) { setStatus('error', 'Sin c\u00e1mara'); }
    }
  }

  async function flipCamera() {
    facingMode = facingMode === 'user' ? 'environment' : 'user';
    updateFlipBtn();
    // Stop current MediaPipe camera loop before re-init
    if (handCamera) { try { handCamera.stop(); } catch(e) {} handCamera = null; }
    mpReady = false; hands = null;
    await startHandStream();
    await loadMediaPipe();
  }

  function updateFlipBtn() {
    const btn = document.getElementById('handFlipBtn');
    if (!btn) return;
    btn.classList.toggle('rear', facingMode === 'environment');
    btn.title = facingMode === 'user' ? 'Cambiar a c\u00e1mara trasera' : 'Cambiar a c\u00e1mara frontal';
  }

  function stopHandSession() {
    if (handCamera) { try { handCamera.stop(); } catch(e) {} handCamera = null; }
    if (handStream) { handStream.getTracks().forEach(t => t.stop()); handStream = null; }
    const v = document.getElementById('handVideo');
    if (v) { v.srcObject = null; v.style.transform = ''; }
    activeCards = []; dragCard = null; dragEngaged = false;
    openPalmCounter = 0; isResetting = false; mpReady = false; hands = null;
  }

  // ── MEDIAPIPE ──────────────────────────────────────────────────────────────
  async function loadMediaPipe() {
    return new Promise((resolve, reject) => {
      if (window.Hands && window.Camera) { initMediaPipe().then(resolve).catch(reject); return; }
      const s1 = document.createElement('script');
      s1.src = 'https://cdn.jsdelivr.net/npm/@mediapipe/hands/hands.js';
      s1.crossOrigin = 'anonymous';
      const s2 = document.createElement('script');
      s2.src = 'https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils/camera_utils.js';
      s2.crossOrigin = 'anonymous';
      s1.onload = () => document.head.appendChild(s2);
      s2.onload = () => initMediaPipe().then(resolve).catch(reject);
      s1.onerror = s2.onerror = reject;
      document.head.appendChild(s1);
    });
  }

  async function initMediaPipe() {
    const video = document.getElementById('handVideo');
    hands = new window.Hands({
      locateFile: f => `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${f}`
    });
    hands.setOptions({
      maxNumHands: 1, modelComplexity: 1,
      minDetectionConfidence: 0.75, minTrackingConfidence: 0.65
    });
    hands.onResults(onHandResults);
    handCamera = new window.Camera(video, {
      onFrame: async () => { if (hands) await hands.send({ image: video }); drawFrame(); },
      width: 1280, height: 720
    });
    await handCamera.start();
    mpReady = true;
    setStatus('ready', 'Listo');
    document.getElementById('handGestureHint').classList.replace('hint-hidden', 'hint-visible');
  }

  // ── GESTURE PROCESSING ─────────────────────────────────────────────────────
  let lastLandmarks = null;

  function onHandResults(results) {
    if (!results.multiHandLandmarks || !results.multiHandLandmarks.length) {
      lastLandmarks = null; handVisible = false; openPalmCounter = 0;
      if (dragEngaged) releaseDrag();
      setStatus('ready', 'Listo');
      updatePalmProgress(0);
      document.getElementById('handResetHint').classList.replace('hint-visible', 'hint-hidden');
      document.getElementById('handDragHint').classList.replace('hint-visible', 'hint-hidden');
      return;
    }

    handVisible   = true;
    lastLandmarks = results.multiHandLandmarks[0];
    const lm      = lastLandmarks;
    const now     = Date.now();
    const mirrorX = facingMode === 'user';

    const pinching = detectPinch(lm);
    const dragging = detectDragGesture(lm);
    const openPalm = detectOpenPalm(lm);

    // ── DRAG ──────────────────────────────────────────────────────────────
    if (dragging) {
      const mx = (lm[12].x + lm[16].x) / 2;
      const my = (lm[12].y + lm[16].y) / 2;
      const nx = mirrorX ? 1 - mx : mx;
      const ny = my;

      if (!dragEngaged) {
        const hit = findCardAt(nx, ny);
        if (hit) {
          dragCard = hit; dragEngaged = true;
          dragCard.isDragging = true;
          lastDragNx = nx; lastDragNy = ny;
          setStatus('drag', 'Moviendo');
          document.getElementById('handDragHint').classList.replace('hint-hidden', 'hint-visible');
          updatePips();
          if (navigator.vibrate) navigator.vibrate(20);
        }
      } else if (dragCard) {
        dragCard.nx = Math.min(0.95, Math.max(0.05, dragCard.nx + (nx - lastDragNx)));
        dragCard.ny = Math.min(0.95, Math.max(0.05, dragCard.ny + (ny - lastDragNy)));
        lastDragNx = nx; lastDragNy = ny;
      }
    } else if (dragEngaged) {
      releaseDrag();
    }

    // ── PINCH → spawn ─────────────────────────────────────────────────────
    if (!dragEngaged && pinching && !isResetting
        && activeCards.length < MAX_CARDS
        && (now - lastPinchTime) > PINCH_COOLDOWN) {
      lastPinchTime = now;
      const nx = mirrorX ? 1 - lm[8].x : lm[8].x;
      spawnCard(nx, lm[8].y);
    }

    // ── OPEN PALM → reset ─────────────────────────────────────────────────
    if (!dragEngaged && openPalm && activeCards.length > 0) {
      openPalmCounter++;
      updatePalmProgress(openPalmCounter / OPEN_PALM_FRAMES);
      document.getElementById('handResetHint').classList.replace('hint-hidden', 'hint-visible');
      if (openPalmCounter >= OPEN_PALM_FRAMES) { openPalmCounter = 0; updatePalmProgress(0); resetCards(); }
    } else if (!dragging) {
      openPalmCounter = Math.max(0, openPalmCounter - 2);
      updatePalmProgress(openPalmCounter / OPEN_PALM_FRAMES);
      if (!openPalmCounter) document.getElementById('handResetHint').classList.replace('hint-visible', 'hint-hidden');
    }

    if (!dragEngaged) setStatus('hand', 'Mano detectada');
  }

  function releaseDrag() {
    if (dragCard) { dragCard.isDragging = false; dragCard = null; }
    dragEngaged = false;
    setStatus('hand', 'Mano detectada');
    document.getElementById('handDragHint').classList.replace('hint-visible', 'hint-hidden');
    updatePips();
    if (navigator.vibrate) navigator.vibrate(15);
  }

  // ── GESTURE DETECTORS ──────────────────────────────────────────────────────
  function dist2D(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }

  function detectPinch(lm) {
    return dist2D(lm[4], lm[8]) < PINCH_THRESH;
  }

  function detectDragGesture(lm) {
    // Middle(12) + Ring(16) close + both extended, index + pinky down
    return dist2D(lm[12], lm[16]) < DRAG_THRESH
      && lm[12].y < lm[10].y   // middle extended
      && lm[16].y < lm[14].y   // ring extended
      && lm[8].y  > lm[6].y    // index NOT extended
      && lm[20].y > lm[18].y;  // pinky NOT extended
  }

  function detectOpenPalm(lm) {
    return [[8,6],[12,10],[16,14],[20,18]].every(([t,p]) => lm[t].y < lm[p].y);
  }

  function findCardAt(nx, ny) {
    for (let i = activeCards.length - 1; i >= 0; i--) {
      const c = activeCards[i];
      if (c.state !== 'visible' && c.state !== 'appearing') continue;
      if (Math.hypot(c.nx - nx, c.ny - ny) < DRAG_HIT_RADIUS) return c;
    }
    return null;
  }

  // ── SPAWN CARD ─────────────────────────────────────────────────────────────
  function spawnCard(nx, ny) {
    if (typeof window.getQuantumByte !== 'function') return;
    const deck = window.currentDeck || 'marsella';
    const lang = window.currentLang || 'es';
    const def  = window.DECKS[deck];
    let idx, n = 0;
    do { idx = window.getQuantumByte() % 22; n++; }
    while (activeCards.some(c => c.cardIndex === idx) && n < 44);

    const name = def[lang][idx];
    const slug = def.slugs[idx];
    const src  = `${def.path}/thumb/${slug}.jpg`;
    let img = imgCache[src];
    if (!img) { img = new Image(); img.src = src; imgCache[src] = img; }

    activeCards.push({ nx, ny, cardIndex: idx, slug, name, img,
      opacity: 0, state: 'appearing', spawnTime: Date.now(), isDragging: false });
    updatePips(); updateCountDisplay();
    speakCard(name);
    if (navigator.vibrate) navigator.vibrate([30, 20, 30]);
  }

  function speakCard(name) {
    const lang = window.currentLang || 'es';
    const cfg  = window.LANG_CONFIG?.[lang] || { lang: 'es-ES' };
    const vol  = parseFloat(document.getElementById('volume')?.value ?? 0.8);
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(name);
    u.lang = cfg.lang; u.rate = 0.75; u.pitch = 1.0; u.volume = vol;
    window.speechSynthesis.speak(u);
  }

  // ── RESET ──────────────────────────────────────────────────────────────────
  function resetCards() {
    if (isResetting || !activeCards.length) return;
    isResetting = true; dragCard = null; dragEngaged = false;
    activeCards.forEach(c => { c.state = 'disappearing'; c.isDragging = false; });
    setTimeout(() => {
      activeCards = []; isResetting = false; openPalmCounter = 0;
      updatePips(); updateCountDisplay();
    }, CARD_RESET_MS + 80);
  }

  // ── CAPTURE SCENE ──────────────────────────────────────────────────────────
  function captureScene() {
    const video   = document.getElementById('handVideo');
    const arCv    = document.getElementById('handCanvas');
    const capCv   = document.getElementById('handCaptureCanvas');
    const W = video.videoWidth  || arCv.width;
    const H = video.videoHeight || arCv.height;
    capCv.width = W; capCv.height = H;
    const ctx = capCv.getContext('2d');

    // Composite video (un-mirror it for capture regardless of facingMode)
    ctx.save();
    if (facingMode === 'user') { ctx.translate(W, 0); ctx.scale(-1, 1); }
    ctx.drawImage(video, 0, 0, W, H);
    ctx.restore();

    // Draw cards at full video resolution
    const cardW = W * CARD_W_RATIO;
    const cardH = cardW * 1.75;
    activeCards.forEach(card => {
      if (card.opacity < 0.05) return;
      drawCardOnCtx(ctx, { ...card, x: card.nx * W, y: card.ny * H }, cardW, cardH);
    });

    // Watermark
    ctx.font      = `bold ${Math.round(W * 0.018)}px 'Space Mono',monospace`;
    ctx.fillStyle = 'rgba(230,48,48,0.85)';
    ctx.textAlign = 'right';
    ctx.shadowColor = 'rgba(0,0,0,0.9)'; ctx.shadowBlur = 6;
    ctx.fillText('ARKANA HAND \u00b7 radioarkana.com', W - 20, 32);
    ctx.shadowBlur = 0;

    // Flash
    const flash = document.getElementById('handFlashOverlay');
    flash.classList.add('flash');
    setTimeout(() => flash.classList.remove('flash'), 200);

    // Download
    const a = document.createElement('a');
    a.href     = capCv.toDataURL('image/jpeg', 0.93);
    a.download = `arkana-hand-${Date.now()}.jpg`;
    a.click();
    if (navigator.vibrate) navigator.vibrate([40, 30, 40]);
  }

  // ── CANVAS HELPERS ─────────────────────────────────────────────────────────
  function getCanvasSize(c) {
    let w = c.offsetWidth, h = c.offsetHeight;
    if (!w || !h) { const r = c.getBoundingClientRect(); w = r.width; h = r.height; }
    if (!w) w = window.innerWidth;
    if (!h) h = window.innerHeight - 60;
    return { w, h };
  }
  function ensureCanvasSize(c) {
    const { w, h } = getCanvasSize(c);
    const dpr = devicePixelRatio || 1;
    const tw = Math.round(w * dpr), th = Math.round(h * dpr);
    if (c.width !== tw || c.height !== th) { c.width = tw; c.height = th; }
  }
  function waitForCanvasSize() {
    return new Promise(res => {
      let n = 0;
      function check() {
        const c = document.getElementById('handCanvas');
        const { w, h } = getCanvasSize(c);
        if ((w > 0 && h > 0) || n++ > 20) res();
        else requestAnimationFrame(check);
      }
      requestAnimationFrame(check);
    });
  }

  // ── DRAW FRAME ─────────────────────────────────────────────────────────────
  function drawFrame() {
    const canvas = document.getElementById('handCanvas');
    if (!canvas) return;
    ensureCanvasSize(canvas);
    if (!canvas.width || !canvas.height) return;

    const ctx   = canvas.getContext('2d');
    const now   = Date.now();
    const cardW = canvas.width  * CARD_W_RATIO;
    const cardH = cardW * 1.75;

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    activeCards = activeCards.filter(card => {
      const el = now - card.spawnTime;
      if (card.state === 'appearing') {
        card.opacity = Math.min(1, el / CARD_APPEAR_MS);
        if (card.opacity >= 1) card.state = 'visible';
      } else if (card.state === 'disappearing') {
        if (!card._ds) card._ds = now;
        card.opacity = Math.max(0, 1 - (now - card._ds) / CARD_RESET_MS);
        if (card.opacity <= 0) return false;
      }
      drawCardOnCtx(ctx, { ...card, x: card.nx * canvas.width, y: card.ny * canvas.height }, cardW, cardH);
      return true;
    });

    if (lastLandmarks && handVisible) drawHandOverlay(ctx, canvas.width, canvas.height);
  }

  // ── DRAW CARD ──────────────────────────────────────────────────────────────
  function drawCardOnCtx(ctx, card, cardW, cardH) {
    const x = card.x - cardW / 2;
    const y = card.y - cardH / 2;
    const r = 8;

    ctx.save();
    ctx.globalAlpha = card.opacity;

    let scale = 1;
    if (card.state === 'appearing') scale = 0.6 + 0.4 * easeOutBack(card.opacity);
    ctx.translate(card.x, card.y); ctx.scale(scale, scale); ctx.translate(-card.x, -card.y);

    // Glow
    ctx.shadowColor   = card.isDragging ? 'rgba(245,158,11,.6)' : 'rgba(230,48,48,.45)';
    ctx.shadowBlur    = card.isDragging ? 30 : 22 * card.opacity;
    ctx.shadowOffsetY = 4;

    // Background
    ctx.beginPath(); roundRect(ctx, x, y, cardW, cardH, r);
    ctx.fillStyle = '#0d0d0d'; ctx.fill();

    // Border
    ctx.strokeStyle = card.isDragging ? `rgba(245,158,11,${.9 * card.opacity})` : `rgba(230,48,48,${.6 * card.opacity})`;
    ctx.lineWidth   = card.isDragging ? 2 : 1.5;
    ctx.stroke();
    ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;

    // Image — fills full card (no label overlay)
    if (card.img && card.img.complete && card.img.naturalWidth > 0) {
      ctx.save();
      ctx.beginPath(); roundRect(ctx, x + 3, y + 3, cardW - 6, cardH - 6, r - 1);
      ctx.clip();
      ctx.drawImage(card.img, x + 3, y + 3, cardW - 6, cardH - 6);
      ctx.restore();
    } else {
      ctx.fillStyle = '#1a0a0a';
      ctx.beginPath(); roundRect(ctx, x + 3, y + 3, cardW - 6, cardH - 6, r - 1);
      ctx.fill();
    }

    // Drag indicator — amber dot at top-center
    if (card.isDragging) {
      ctx.beginPath();
      ctx.arc(x + cardW / 2, y + 11, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(245,158,11,.95)'; ctx.fill();
    }

    ctx.restore();
  }

  // ── HAND OVERLAY ───────────────────────────────────────────────────────────
  function drawHandOverlay(ctx, W, H) {
    const lm = lastLandmarks;
    const m  = facingMode === 'user';
    const px = p => (m ? 1 - p.x : p.x) * W;
    const py = p => p.y * H;

    const CONN = [
      [0,1],[1,2],[2,3],[3,4],
      [0,5],[5,6],[6,7],[7,8],
      [5,9],[9,10],[10,11],[11,12],
      [9,13],[13,14],[14,15],[15,16],
      [13,17],[17,18],[18,19],[19,20],[0,17]
    ];
    ctx.save();
    ctx.strokeStyle = dragEngaged ? 'rgba(245,158,11,.28)' : 'rgba(230,48,48,.2)';
    ctx.lineWidth   = 1;
    CONN.forEach(([a, b]) => {
      ctx.beginPath(); ctx.moveTo(px(lm[a]), py(lm[a])); ctx.lineTo(px(lm[b]), py(lm[b])); ctx.stroke();
    });
    const pts = dragEngaged ? [12, 16] : [4, 8];
    pts.forEach(i => {
      ctx.beginPath(); ctx.arc(px(lm[i]), py(lm[i]), 4, 0, Math.PI * 2);
      ctx.fillStyle = dragEngaged ? 'rgba(245,158,11,.7)' : 'rgba(230,48,48,.6)';
      ctx.fill();
    });
    ctx.restore();
  }

  // ── UI HELPERS ─────────────────────────────────────────────────────────────
  function setStatus(state, text) {
    const dot = document.getElementById('handStatusDot');
    const lbl = document.getElementById('handStatusText');
    if (dot) dot.className     = state;
    if (lbl) lbl.textContent   = text;
  }

  function updatePips() {
    for (let i = 0; i < 4; i++) {
      const pip  = document.getElementById(`pip${i}`);
      const card = activeCards[i];
      if (!pip) continue;
      pip.classList.toggle('filled',   i < activeCards.length && !card?.isDragging);
      pip.classList.toggle('dragging', !!card?.isDragging);
    }
    const lbl  = document.getElementById('handGestureLabel');
    const icon = document.getElementById('handGestureIcon');
    if (lbl && icon) {
      if (activeCards.length >= MAX_CARDS) { lbl.textContent = 'Palma abierta para resetear'; icon.textContent = '\u25fb'; }
      else { lbl.textContent = 'Pinch para materializar'; icon.textContent = '\u2726'; }
    }
  }

  function updateCountDisplay() {
    const n = document.getElementById('handCountNum');
    if (!n) return;
    n.textContent = activeCards.length;
    if (activeCards.length >= MAX_CARDS) { n.classList.add('full'); setTimeout(() => n.classList.remove('full'), 400); }
  }

  function updatePalmProgress(t) {
    const w = document.getElementById('handPalmProgress');
    const a = document.getElementById('handPalmArc');
    if (!w || !a) return;
    w.classList.toggle('visible', t > 0.05);
    const d = Math.min(100, t * 100).toFixed(1);
    a.setAttribute('stroke-dasharray', `${d} ${(100 - parseFloat(d)).toFixed(1)}`);
  }

  // ── MATH ───────────────────────────────────────────────────────────────────
  function easeOutBack(t) {
    const c1 = 1.70158, c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y);
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
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', injectHTML);
  else injectHTML();

})();
