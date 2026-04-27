// Voice-mode 3D sphere visualization. Audio-reactive Jarvis-style core with
// orbiting rings + particle halo. Three.js (loaded via CDN script tag).
//
// API:
//   VoiceSphere.show(mode)              // 'fullscreen' | 'split' | 'floating'
//   VoiceSphere.hide()
//   VoiceSphere.setMode(mode)
//   VoiceSphere.setState(state)         // 'idle' | 'listening' | 'thinking' | 'speaking'
//   VoiceSphere.attachMicAnalyser(node)
//   VoiceSphere.attachTtsAnalyser(node)
//   VoiceSphere.playStartupChime()
//
// All state is internal — caller just toggles modes/states and pumps audio
// analyser nodes when they have them.

(function () {
  'use strict';

  const VERTEX_SHADER = `
    uniform float uTime;
    uniform float uAmplitude;
    uniform float uNoiseScale;
    varying vec3 vNormal;
    varying float vDisp;

    // Classic 3D simplex noise (cheap variant)
    vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
    vec4 mod289(vec4 x){return x-floor(x*(1.0/289.0))*289.0;}
    vec4 permute(vec4 x){return mod289(((x*34.0)+1.0)*x);}
    vec4 taylorInvSqrt(vec4 r){return 1.79284291400159-0.85373472095314*r;}
    float snoise(vec3 v){
      const vec2 C=vec2(1.0/6.0,1.0/3.0); const vec4 D=vec4(0.0,0.5,1.0,2.0);
      vec3 i=floor(v+dot(v,C.yyy)); vec3 x0=v-i+dot(i,C.xxx);
      vec3 g=step(x0.yzx,x0.xyz); vec3 l=1.0-g;
      vec3 i1=min(g.xyz,l.zxy); vec3 i2=max(g.xyz,l.zxy);
      vec3 x1=x0-i1+C.xxx; vec3 x2=x0-i2+C.yyy; vec3 x3=x0-D.yyy;
      i=mod289(i);
      vec4 p=permute(permute(permute(i.z+vec4(0.0,i1.z,i2.z,1.0))+i.y+vec4(0.0,i1.y,i2.y,1.0))+i.x+vec4(0.0,i1.x,i2.x,1.0));
      float n_=0.142857142857; vec3 ns=n_*D.wyz-D.xzx;
      vec4 j=p-49.0*floor(p*ns.z*ns.z); vec4 x_=floor(j*ns.z); vec4 y_=floor(j-7.0*x_);
      vec4 x=x_*ns.x+ns.yyyy; vec4 y=y_*ns.x+ns.yyyy; vec4 h=1.0-abs(x)-abs(y);
      vec4 b0=vec4(x.xy,y.xy); vec4 b1=vec4(x.zw,y.zw);
      vec4 s0=floor(b0)*2.0+1.0; vec4 s1=floor(b1)*2.0+1.0; vec4 sh=-step(h,vec4(0.0));
      vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy; vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
      vec3 p0=vec3(a0.xy,h.x); vec3 p1=vec3(a0.zw,h.y); vec3 p2=vec3(a1.xy,h.z); vec3 p3=vec3(a1.zw,h.w);
      vec4 norm=taylorInvSqrt(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
      p0*=norm.x; p1*=norm.y; p2*=norm.z; p3*=norm.w;
      vec4 m=max(0.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.0);
      m=m*m;
      return 42.0*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
    }

    void main() {
      vNormal = normal;
      // Tighter, calmer displacement — was 0.15 + amp*0.55 which made the
      // sphere look like a wobbling blob. Now a small base ripple plus a
      // sharper amplitude reaction keeps the core looking like a solid orb
      // that breathes, not a lava lamp.
      float n = snoise(normal * uNoiseScale + uTime * 0.4);
      float disp = n * (0.04 + uAmplitude * 0.22);
      vDisp = disp;
      vec3 newPos = position + normal * disp;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(newPos, 1.0);
    }
  `;

  const FRAGMENT_SHADER = `
    uniform float uTime;
    uniform float uAmplitude;
    varying vec3 vNormal;
    varying float vDisp;
    void main() {
      // Blue palette: deep electric blue → cyan highlights on displaced peaks
      vec3 base = vec3(0.05, 0.30, 0.85);
      vec3 hot  = vec3(0.55, 0.90, 1.00);
      float intensity = clamp(vDisp * 2.5 + uAmplitude * 0.6, 0.0, 1.0);
      vec3 color = mix(base, hot, intensity);
      // Fresnel rim glow
      float rim = pow(1.0 - max(dot(vNormal, vec3(0.0, 0.0, 1.0)), 0.0), 2.5);
      color += vec3(0.30, 0.65, 1.00) * rim * (0.7 + uAmplitude * 0.6);
      gl_FragColor = vec4(color, 0.92);
    }
  `;

  const HALO_FRAGMENT = `
    uniform float uAmplitude;
    varying vec3 vNormal;
    void main() {
      float rim = pow(1.0 - max(dot(vNormal, vec3(0.0, 0.0, 1.0)), 0.0), 3.0);
      vec3 col = vec3(0.20, 0.55, 1.00) * rim;
      gl_FragColor = vec4(col, rim * (0.4 + uAmplitude * 0.5));
    }
  `;
  const HALO_VERTEX = `
    varying vec3 vNormal;
    void main() {
      vNormal = normal;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position * 1.18, 1.0);
    }
  `;

  let scene, camera, renderer, container, root;
  let core, halo, particles, particles2;
  let rings = [];      // outer torus rings at various tilts
  let wires = [];      // inner wireframe geometries (icosa + octa)
  let coreMat, haloMat, dotMat;
  let micAnalyser = null, ttsAnalyser = null;
  let micBuf = null, ttsBuf = null;
  let state = 'idle';
  let smoothedAmp = 0;
  let raf = null;
  let visible = false;
  let viewMode = 'split';
  let startTime = 0;
  let materializeT = 0;

  function ensureDOM() {
    if (root) return;
    root = document.createElement('div');
    root.id = 'voice-sphere-root';
    root.className = 'vs-hidden vs-mode-split';
    root.innerHTML = `
      <div class="vs-canvas-wrap"><canvas id="vs-canvas"></canvas></div>
      <button class="vs-mode-toggle" title="Cycle view mode">⇄</button>
      <button class="vs-back-btn" title="Back to chat">←</button>
    `;
    document.body.appendChild(root);
    container = root.querySelector('.vs-canvas-wrap');
    root.querySelector('.vs-mode-toggle').addEventListener('click', cycleMode);
    root.querySelector('.vs-back-btn').addEventListener('click', () => {
      if (typeof window.stopVoiceMode === 'function') window.stopVoiceMode();
      else hide();
    });
  }

  function initThree() {
    if (scene) return;
    const canvas = root.querySelector('#vs-canvas');
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    // Pulled back so the sphere reads as a self-contained object inside the
    // viewport instead of bleeding off the edges on big monitors.
    camera.position.z = 4.6;
    renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    // ── Bright hot core (small, additive) — the energy point at the center
    haloMat = new THREE.ShaderMaterial({
      vertexShader: HALO_VERTEX,
      fragmentShader: HALO_FRAGMENT,
      uniforms: { uAmplitude: { value: 0 } },
      transparent: true, blending: THREE.AdditiveBlending, depthWrite: false,
    });
    halo = new THREE.Mesh(new THREE.IcosahedronGeometry(0.35, 3), haloMat);
    scene.add(halo);

    // ── Internal wireframe architecture (icosa + octa + lat/long sphere)
    const wireMat = new THREE.LineBasicMaterial({
      color: 0x4ca8ff, transparent: true, opacity: 0.55, depthWrite: false,
    });
    const wireMatBright = new THREE.LineBasicMaterial({
      color: 0x9fdcff, transparent: true, opacity: 0.85, depthWrite: false,
    });
    // Inner architecture: icosa + octa kept smaller than the rings so they
    // sit inside the orb instead of competing with it.
    const ico = new THREE.LineSegments(
      new THREE.WireframeGeometry(new THREE.IcosahedronGeometry(0.55, 1)),
      wireMat,
    );
    scene.add(ico); wires.push(ico);
    const octa = new THREE.LineSegments(
      new THREE.WireframeGeometry(new THREE.OctahedronGeometry(0.75, 0)),
      wireMatBright,
    );
    scene.add(octa); wires.push(octa);
    // Subtle lat/long sphere wireframe — sparser segs so it reads as a faint
    // dome shell, not a fishnet.
    const latLong = new THREE.LineSegments(
      new THREE.WireframeGeometry(new THREE.SphereGeometry(1.35, 12, 8)),
      new THREE.LineBasicMaterial({ color: 0x3a8fcf, transparent: true, opacity: 0.14, depthWrite: false }),
    );
    scene.add(latLong); wires.push(latLong);

    // ── Multiple orbital rings at varied tilts/radii
    const ringDef = [
      { r: 1.55, tube: 0.006, opacity: 0.85, rot: [Math.PI / 2.4, 0, 0] },
      { r: 1.62, tube: 0.005, opacity: 0.65, rot: [Math.PI / 3.2, Math.PI / 2, 0] },
      { r: 1.74, tube: 0.005, opacity: 0.55, rot: [Math.PI / 1.8, Math.PI / 5, 0] },
      { r: 1.85, tube: 0.004, opacity: 0.45, rot: [Math.PI / 2.8, Math.PI / 7, Math.PI / 3] },
    ];
    for (const def of ringDef) {
      const m = new THREE.MeshBasicMaterial({
        color: 0x6dd6ff, transparent: true, opacity: def.opacity, depthWrite: false,
      });
      const r = new THREE.Mesh(new THREE.TorusGeometry(def.r, def.tube, 4, 256), m);
      r.rotation.set(def.rot[0], def.rot[1], def.rot[2]);
      scene.add(r); rings.push(r);
    }

    // ── Dense outer particle shell — the dyson-sphere of dots
    const pCount = 2200;
    const pPos = new Float32Array(pCount * 3);
    const pSize = new Float32Array(pCount);
    for (let i = 0; i < pCount; i++) {
      // Thin shell — particles hug the orb surface tightly. r=1.45..1.55
      // gives a clean dyson-sphere look instead of a fuzzy halo.
      const r = 1.45 + Math.random() * 0.10;
      const t = Math.random() * Math.PI * 2;
      const p = Math.acos(2 * Math.random() - 1);
      pPos[i * 3]     = r * Math.sin(p) * Math.cos(t);
      pPos[i * 3 + 1] = r * Math.sin(p) * Math.sin(t);
      pPos[i * 3 + 2] = r * Math.cos(p);
      pSize[i] = 0.4 + Math.random() * 0.5;
    }
    const pGeom = new THREE.BufferGeometry();
    pGeom.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
    pGeom.setAttribute('aSize', new THREE.BufferAttribute(pSize, 1));
    // Custom shader to render crisp circular dots (default Three.js Points
    // are flat squares). Discard outside unit circle, soft anti-aliased edge.
    dotMat = new THREE.ShaderMaterial({
      uniforms: {
        uPxScale: { value: 1.0 },
        uAmplitude: { value: 0 },
        uTime: { value: 0 },
        uPulse: { value: 0 },   // 0..1, set externally during 'speaking'
      },
      vertexShader: `
        attribute float aSize;
        uniform float uPxScale;
        uniform float uAmplitude;
        uniform float uTime;
        uniform float uPulse;
        void main() {
          // Per-particle swarming drift: each dot bobs along its own normal
          // by a tiny amount, with phase derived from its position so the
          // motion feels organic rather than a unison wobble.
          float seed = position.x * 12.9898 + position.y * 78.233 + position.z * 37.719;
          float drift = sin(uTime * 0.9 + seed) * (0.012 + uAmplitude * 0.04);
          vec3 outward = normalize(position);
          vec3 p = position + outward * drift;
          vec4 mvPos = modelViewMatrix * vec4(p, 1.0);
          // Cap dot pixel size hard so we never get blown-out white pixels.
          // Pulse adds visible size punch when the agent is talking.
          float pulseFactor = 1.0 + uPulse * 0.55;
          float ps = aSize * uPxScale * (1.0 + uAmplitude * 0.25) * pulseFactor * (12.0 / -mvPos.z);
          gl_PointSize = clamp(ps, 0.6, 4.5);
          gl_Position = projectionMatrix * mvPos;
        }
      `,
      fragmentShader: `
        uniform float uAmplitude;
        uniform float uPulse;
        void main() {
          vec2 c = gl_PointCoord - vec2(0.5);
          float d = length(c);
          if (d > 0.5) discard;
          float alpha = smoothstep(0.5, 0.30, d);
          // Cool blue palette — kept pretty restrained per-dot since hundreds
          // of dots overlap with additive blending. Brighten on pulse so the
          // dots clearly throb in time with the agent's voice.
          vec3 col = mix(vec3(0.45, 0.75, 1.00), vec3(0.85, 0.95, 1.00), uPulse * 0.6);
          gl_FragColor = vec4(col, alpha * (0.32 + uAmplitude * 0.18 + uPulse * 0.20));
        }
      `,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    particles = new THREE.Points(pGeom, dotMat);
    scene.add(particles);

    // Sparser, wider scatter for depth — dots that drift outside the main shell
    const p2Count = 600;
    const p2Pos = new Float32Array(p2Count * 3);
    const p2Size = new Float32Array(p2Count);
    for (let i = 0; i < p2Count; i++) {
      const r = 1.6 + Math.pow(Math.random(), 2.0) * 0.5;
      const t = Math.random() * Math.PI * 2;
      const p = Math.acos(2 * Math.random() - 1);
      p2Pos[i * 3]     = r * Math.sin(p) * Math.cos(t);
      p2Pos[i * 3 + 1] = r * Math.sin(p) * Math.sin(t);
      p2Pos[i * 3 + 2] = r * Math.cos(p);
      p2Size[i] = 0.3 + Math.random() * 0.4;
    }
    const p2Geom = new THREE.BufferGeometry();
    p2Geom.setAttribute('position', new THREE.BufferAttribute(p2Pos, 3));
    p2Geom.setAttribute('aSize', new THREE.BufferAttribute(p2Size, 1));
    particles2 = new THREE.Points(p2Geom, dotMat);
    scene.add(particles2);

    window.addEventListener('resize', resize);
    resize();
  }

  function resize() {
    if (!renderer || !container) return;
    const r = container.getBoundingClientRect();
    const w = Math.max(1, Math.floor(r.width));
    const h = Math.max(1, Math.floor(r.height));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  function readAmplitude(analyser, buf) {
    if (!analyser) return 0;
    analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = (buf[i] - 128) / 128;
      sum += v * v;
    }
    return Math.min(1, Math.sqrt(sum / buf.length) * 2.4);
  }

  function tick() {
    if (!visible) { raf = null; return; }
    raf = requestAnimationFrame(tick);
    const t = (performance.now() - startTime) / 1000;
    let targetAmp;
    if (state === 'listening') {
      targetAmp = readAmplitude(micAnalyser, micBuf);
    } else if (state === 'speaking') {
      // Always pulse a baseline (so user sees motion even if the analyser
      // tap is reading zero for some reason), plus add the actual TTS
      // amplitude on top. With both, the sphere visibly reacts to the
      // agent's voice without ever appearing frozen.
      const live = readAmplitude(ttsAnalyser, ttsBuf);
      const baseline = 0.32 + 0.18 * Math.sin(t * 6.5);
      targetAmp = Math.max(baseline, live);
    } else if (state === 'thinking') {
      targetAmp = 0.25 + 0.15 * Math.sin(t * 4);
    } else {
      targetAmp = 0.10 + 0.05 * Math.sin(t * 1.2);
    }
    smoothedAmp += (targetAmp - smoothedAmp) * 0.18;

    haloMat.uniforms.uAmplitude.value = smoothedAmp;
    dotMat.uniforms.uAmplitude.value = smoothedAmp;
    dotMat.uniforms.uTime.value = t;

    // Pulsating breath when agent talks. Drives:
    //   - whole composition scale (rings + dot shells expand/contract)
    //   - dot size + brightness (via shader uPulse uniform)
    //   - ring opacity boost
    // A sin pulse synced with the smoothed audio amplitude keeps it rhythmic.
    if (materializeT >= 1) {
      let breath, ringAlphaBoost, pulse;
      if (state === 'speaking') {
        pulse = 0.5 + 0.5 * Math.sin(t * 7);          // 0..1, ~1.1Hz
        breath = 1.0 + (0.04 + smoothedAmp * 0.05) * pulse;
        ringAlphaBoost = (0.20 + smoothedAmp * 0.30) * pulse;
      } else if (state === 'listening' || state === 'thinking') {
        pulse = 0;
        breath = 1.0 + smoothedAmp * 0.03;
        ringAlphaBoost = 0;
      } else {
        pulse = 0;
        breath = 1.0;
        ringAlphaBoost = 0;
      }
      dotMat.uniforms.uPulse.value = pulse;
      halo.scale.setScalar(breath * 1.4);
      particles.scale.setScalar(breath);
      particles2.scale.setScalar(breath);
      rings.forEach((r) => {
        r.scale.setScalar(breath);
        const baseOp = r.userData.baseOp ?? (r.userData.baseOp = r.material.opacity);
        r.material.opacity = Math.min(1, baseOp + ringAlphaBoost);
      });
    }

    const ringSpeed = state === 'thinking' ? 1.6 : (state === 'speaking' ? 1.0 : 0.65);
    // Each ring rotates around different axes at different rates and
    // directions so the rings visibly tumble through 3D, not just spin
    // on one plane. Per-ring axis tuples below give the "armillary sphere"
    // motion — the outer rings are biggest, so they read the strongest.
    const ringAxisRates = [
      [ 0.0090,  0.0020,  0.0040],   // ring 0 — fastest, primary
      [-0.0070,  0.0050, -0.0025],
      [ 0.0035, -0.0080,  0.0030],
      [-0.0030,  0.0045, -0.0070],
    ];
    rings.forEach((r, i) => {
      const ax = ringAxisRates[i] || [0.005, 0.002, 0.001];
      r.rotation.x += ax[0] * ringSpeed;
      r.rotation.y += ax[1] * ringSpeed;
      r.rotation.z += ax[2] * ringSpeed;
    });
    // Wireframes spin subtly around their own axes
    wires[0].rotation.y += 0.0030;
    wires[0].rotation.x += 0.0012;
    wires[1].rotation.y -= 0.0024;
    wires[1].rotation.z += 0.0018;
    wires[2].rotation.y += 0.0006; // lat/long stays nearly still

    // Particle shells rotate at different speeds for parallax depth
    particles.rotation.y  += 0.0012;
    particles.rotation.x  += 0.0003;
    particles2.rotation.y -= 0.0008;
    particles2.rotation.z += 0.0004;

    // Materialize-in animation (first ~600ms): scale up from a dot
    if (materializeT < 1) {
      materializeT = Math.min(1, materializeT + 0.025);
      const s = easeOutBack(materializeT);
      halo.scale.setScalar(s);
      rings.forEach(r => r.scale.setScalar(s));
      wires.forEach(w => w.scale.setScalar(s));
      particles.scale.setScalar(s);
      particles2.scale.setScalar(s);
    }

    renderer.render(scene, camera);
  }

  function easeOutBack(x) {
    const c1 = 1.70158, c3 = c1 + 1;
    return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
  }

  function show(mode) {
    ensureDOM();
    if (mode) viewMode = mode;
    setMode(viewMode);
    initThree();
    if (!micBuf && THREE) micBuf = new Uint8Array(2048);
    if (!ttsBuf) ttsBuf = new Uint8Array(2048);
    root.classList.remove('vs-hidden');
    visible = true;
    materializeT = 0;
    startTime = performance.now();
    resize();
    if (!raf) tick();
    playStartupChime();
  }

  function hide() {
    if (!root) return;
    root.classList.add('vs-hidden');
    visible = false;
    if (raf) cancelAnimationFrame(raf);
    raf = null;
    micAnalyser = null; ttsAnalyser = null;
  }

  function setMode(mode) {
    if (!root) return;
    viewMode = mode;
    root.classList.remove('vs-mode-fullscreen', 'vs-mode-split', 'vs-mode-floating');
    root.classList.add('vs-mode-' + mode);
    try { localStorage.setItem('lax_voice_view_mode', mode); } catch {}
    setTimeout(resize, 60);
  }

  function cycleMode() {
    const order = ['split', 'fullscreen', 'floating'];
    const i = order.indexOf(viewMode);
    setMode(order[(i + 1) % order.length]);
  }

  function setState(s) {
    if (['idle', 'listening', 'thinking', 'speaking'].includes(s)) state = s;
  }

  function attachMicAnalyser(node) { micAnalyser = node || null; }
  function attachTtsAnalyser(node) { ttsAnalyser = node || null; }

  let chimeCtx = null;
  function playStartupChime() {
    try {
      chimeCtx = chimeCtx || new (window.AudioContext || window.webkitAudioContext)();
      const ctx = chimeCtx;
      const now = ctx.currentTime;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(660, now);
      osc.frequency.exponentialRampToValueAtTime(880, now + 0.22);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.18, now + 0.04);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.30);
      osc.connect(gain).connect(ctx.destination);
      osc.start(now); osc.stop(now + 0.32);
    } catch {}
  }

  window.VoiceSphere = {
    show, hide, setMode, setState,
    attachMicAnalyser, attachTtsAnalyser,
    playStartupChime,
    get currentMode() { return viewMode; },
    get currentState() { return state; },
  };
})();
