// GLSL shader sources for the voice sphere. Kept as plain strings so they're
// trivially editable without touching the JS that wires uniforms.
//
// CORE_VERTEX / CORE_FRAGMENT   — the surface-displaced "Jarvis core" sphere
// HALO_VERTEX / HALO_FRAGMENT   — small additive halo around the core
// DOT_VERTEX / DOT_FRAGMENT     — particle shell (crisp circular sprites)

export const CORE_VERTEX = `
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

export const CORE_FRAGMENT = `
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

export const HALO_VERTEX = `
  varying vec3 vNormal;
  void main() {
    vNormal = normal;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position * 1.18, 1.0);
  }
`;

export const HALO_FRAGMENT = `
  uniform float uAmplitude;
  varying vec3 vNormal;
  void main() {
    float rim = pow(1.0 - max(dot(vNormal, vec3(0.0, 0.0, 1.0)), 0.0), 3.0);
    vec3 col = vec3(0.20, 0.55, 1.00) * rim;
    gl_FragColor = vec4(col, rim * (0.4 + uAmplitude * 0.5));
  }
`;

export const DOT_VERTEX = `
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
    float ps = aSize * uPxScale * (1.0 + uAmplitude * 0.25) * pulseFactor * (14.0 / -mvPos.z);
    gl_PointSize = clamp(ps, 0.8, 6.0);
    gl_Position = projectionMatrix * mvPos;
  }
`;

export const DOT_FRAGMENT = `
  uniform float uAmplitude;
  uniform float uPulse;
  void main() {
    vec2 c = gl_PointCoord - vec2(0.5);
    float d = length(c);
    if (d > 0.5) discard;
    float alpha = smoothstep(0.5, 0.30, d);
    // Cool blue palette, brighter than v1 so emoji/text silhouettes read
    // clearly through the dimmed rings. Pulse still adds extra punch when
    // the agent is talking.
    vec3 col = mix(vec3(0.70, 0.88, 1.00), vec3(0.92, 0.98, 1.00), uPulse * 0.6);
    gl_FragColor = vec4(col, alpha * (0.55 + uAmplitude * 0.20 + uPulse * 0.22));
  }
`;
