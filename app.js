/* ============================================================
   RYUK* DESIGN STUDIO — app.js
   Premium dark portfolio — GSAP + Lenis + ScrollTrigger
   ============================================================ */

"use strict";

// ── UTILS ──────────────────────────────────────────────────────────────
const q = (sel, ctx = document) => ctx.querySelector(sel);
const qq = (sel, ctx = document) => [...ctx.querySelectorAll(sel)];
const year = () => new Date().getFullYear() % 100;

// Set year everywhere
qq(".js-year").forEach((el) => (el.textContent = String(year()).padStart(2, "0")));

// ── CHROMA-KEY MODEL CUTOUT ─────────────────────────────────────────────
function generateModelCutout() {
  const fgImg = document.getElementById("heroFgImg");
  if (!fgImg) return;

  // Set the original src immediately so GSAP reveal always finds an image,
  // even if the canvas enhancement hasn't run yet.
  // CSS mix-blend-mode:screen (set in style.css) removes black on dark bg as fallback.
  fgImg.src = "images/viper_model_black.png";

  const img = new Image();
  img.crossOrigin = "anonymous";
  img.src = "images/viper_model_black.png";

  img.onload = () => {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(img, 0, 0);
      const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = imgData.data;
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        const brightness = (r + g + b) / 3;
        if (brightness < 16) {
          data[i + 3] = 0;
        } else if (brightness < 45) {
          const alpha = ((brightness - 16) / (45 - 16)) * 255;
          data[i + 3] = Math.min(data[i + 3], alpha);
        }
      }
      ctx.putImageData(imgData, 0, 0);
      // Canvas succeeded: use alpha-removed PNG (cleaner than screen blend)
      fgImg.src = canvas.toDataURL("image/png");
      fgImg.style.mixBlendMode = "normal"; // clean alpha, no need for screen blend
    } catch (e) {
      // CORS on file:// protocol: keep original src + screen blend CSS fallback
      console.warn("Chroma-key via canvas failed (expected on file:// protocol). CSS screen-blend active.", e);
      // fgImg.src already set above — CSS mix-blend-mode:screen handles black bg removal
    }
  };

  img.onerror = () => {
    // Image failed to load — nothing to show, but don't hide the element.
    console.error("viper_model_black.png failed to load.");
  };
}

// ── WebGL FLUID SIMULATION (GPU Navier-Stokes) ─────────────────────────
// Full GPU-accelerated fluid simulation with GLSL shaders.
// Based on Jos Stam's "Stable Fluids" paper and GPU Gems Ch.38.
// Uses ping-pong framebuffers for all simulation steps.
class LiquidShader {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = canvas.getContext("webgl2", {
      alpha: false,
      depth: false,
      stencil: false,
      antialias: true,
      powerPreference: "high-performance",
    });
    if (!this.gl) {
      console.warn("WebGL 2 not supported for LiquidShader");
      return;
    }

    this.pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
    this.resize();

    // Shader parameter defaults matching voltra
    this.params = {
      colors: [
        [0.0, 0.0, 0.0, 1.0], // rgb(0,0,0)
        [69 / 255, 69 / 255, 69 / 255, 1.0], // rgb(69,69,69)
        [84 / 255, 84 / 255, 84 / 255, 1.0], // rgb(84,84,84)
        [112 / 255, 112 / 255, 112 / 255, 1.0], // rgb(112,112,112)
        [189 / 255, 189 / 255, 189 / 255, 1.0], // rgb(189,189,189)
      ],
      seed: 585.0,
      speed: 1.1,
      loop: 0.0,
      scale: 0.56,
      turbAmp: 0.23,
      turbFreq: 0.1,
      turbIter: 7.0,
      waveFreq: 3.8,
      distBias: 0.0,
      jellify: 0.0, // false
      ditherMode: 1.0, // Smooth (IGN)
      dither: 0.2,
      exposure: 1.1,
      contrast: 1.1,
      saturation: 1.0,
    };

    this.init();

    window.addEventListener("resize", () => this.resize());
  }

  resize() {
    const displayWidth = this.canvas.clientWidth;
    const displayHeight = this.canvas.clientHeight;

    if (this.canvas.width !== displayWidth || this.canvas.height !== displayHeight) {
      this.canvas.width = displayWidth;
      this.canvas.height = displayHeight;
    }
  }

  init() {
    const gl = this.gl;

    // Vertex Shader
    const vsSource = `#version 300 es
      in vec2 a_position;
      out vec2 v_uv;
      void main() {
        v_uv = a_position * 0.5 + 0.5;
        gl_Position = vec4(a_position, 0.0, 1.0);
      }
    `;

    // Fragment Shader
    const fsSource = `#version 300 es
      precision highp float;
      precision highp int;
      
      in vec2 v_uv;
      out vec4 fragColor;
      
      uniform vec2 u_resolution;
      uniform float u_time;
      uniform float u_pixelRatio;
      
      uniform vec4 u_colors[8];
      uniform int u_colors_length;
      
      uniform float u_seed;
      uniform float u_speed;
      uniform float u_loop;
      uniform float u_scale;
      uniform float u_turbAmp;
      uniform float u_turbFreq;
      uniform float u_turbIter;
      uniform float u_waveFreq;
      uniform float u_distBias;
      uniform float u_jellify;
      uniform float u_ditherMode;
      uniform float u_dither;
      uniform float u_exposure;
      uniform float u_contrast;
      uniform float u_saturation;
      
      const float GOLDEN_ANGLE = 2.3999632;
      const float TAU = 6.28318530;
      
      uvec3 hash3(uvec3 v) {
          v = v * 1664525u + 1013904223u;
          v.x += v.y * v.z;
          v.y += v.z * v.x;
          v.z += v.x * v.y;
          v ^= v >> 16u;
          v.x += v.y * v.z;
          v.y += v.z * v.x;
          v.z += v.x * v.y;
          return v;
      }
      
      vec3 seedRandom(float seedVal) {
          uvec3 s = uvec3(
              floatBitsToUint(seedVal),
              floatBitsToUint(seedVal * 1.5 + 7.31),
              floatBitsToUint(seedVal * 2.7 + 13.37)
          );
          s = hash3(s);
          return vec3(s) / float(0xFFFFFFFFu);
      }
      
      vec3 toLinear(vec3 c) {
          return pow(c, vec3(2.2));
      }
      
      vec3 toSrgb(vec3 c) {
          return pow(clamp(c, 0.0, 1.0), vec3(0.4545));
      }
      
      vec3 linearToOklab(vec3 c) {
          float l = 0.4122214708 * c.r + 0.5363325363 * c.g + 0.0514459929 * c.b;
          float m = 0.2119034982 * c.r + 0.6806995451 * c.g + 0.1073969566 * c.b;
          float s = 0.0883024619 * c.r + 0.2817188376 * c.g + 0.6299787005 * c.b;
          
          l = pow(max(l, 0.0), 1.0/3.0);
          m = pow(max(m, 0.0), 1.0/3.0);
          s = pow(max(s, 0.0), 1.0/3.0);
          
          return vec3(
              0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
              1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
              0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s
          );
      }
      
      vec3 oklabToLinear(vec3 c) {
          float l = c.x + 0.3963377774 * c.y + 0.2158037573 * c.z;
          float m = c.x - 0.1055613458 * c.y - 0.0638541728 * c.z;
          float s = c.x - 0.0894841775 * c.y - 1.2914855480 * c.z;
          
          l = l * l * l;
          m = m * m * m;
          s = s * s * s;
          
          return vec3(
              +4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
              -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
              -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
          );
      }
      
      vec3 oklabToLch(vec3 lab) {
          return vec3(lab.x, length(lab.yz), atan(lab.z, lab.y));
      }
      
      vec3 lchToOklab(vec3 lch) {
          return vec3(lch.x, lch.y * cos(lch.z), lch.y * sin(lch.z));
      }
      
      vec3 mixLch(vec3 lab0, vec3 lab1, float t) {
          vec3 lch0 = oklabToLch(lab0);
          vec3 lch1 = oklabToLch(lab1);
          
          if (lch0.y < 0.05) lch0.z = lch1.z;
          if (lch1.y < 0.05) lch1.z = lch0.z;
          
          float dh = lch1.z - lch0.z;
          if (dh > 3.14159265) dh -= 6.28318530;
          if (dh < -3.14159265) dh += 6.28318530;
          
          return lchToOklab(vec3(
              mix(lch0.x, lch1.x, t),
              mix(lch0.y, lch1.y, t),
              lch0.z + dh * t
          ));
      }
      
      vec3 getColor(int idx) {
          if (u_colors_length < 1) return vec3(0.0);
          int safeIdx = clamp(idx, 0, u_colors_length - 1);
          return u_colors[safeIdx].rgb;
      }
      
      vec3 paletteN(float t, int count) {
          if (count < 1) return vec3(0.0);
          if (count < 2) return toLinear(getColor(0));
          
          float segmentSize = 1.0 / float(count - 1);
          t = clamp(t, 0.0, 1.0);
          int idx = min(int(floor(t / segmentSize)), count - 2);
          float localT = clamp((t - float(idx) * segmentSize) / segmentSize, 0.0, 1.0);
          
          vec3 lab0 = linearToOklab(toLinear(getColor(idx)));
          vec3 lab1 = linearToOklab(toLinear(getColor(idx + 1)));
          
          return oklabToLinear(mixLch(lab0, lab1, localT));
      }
      
      float IGN(vec2 uv) {
          return fract(52.9829189 * fract(dot(uv, vec2(0.06711056, 0.00583715))));
      }
      
      float quickNoise(vec2 I) {
          return fract(sin(dot(I, vec2(12.9898, 78.233))) * 43758.5453);
      }
      
      float getDither(vec2 I, float mode) {
          if (mode < 0.5) return 0.5;          // 0: Off
          if (mode < 1.5) return IGN(I);       // 1: Smooth
          return quickNoise(I);                // 2: Grain
      }
      
      vec3 softGamutMap(vec3 linearRgb) {
          float maxC = max(linearRgb.r, max(linearRgb.g, linearRgb.b));
          float minC = min(linearRgb.r, min(linearRgb.g, linearRgb.b));
          
          if (minC >= 0.0 && maxC <= 1.0) return linearRgb;
          
          vec3 lab = linearToOklab(max(linearRgb, 0.0));
          float L = clamp(lab.x, 0.0, 1.0);
          float C = length(lab.yz);
          float h = atan(lab.z, lab.y);
          
          float maxChroma = 0.4 * (1.0 - pow(abs(2.0 * L - 1.0), 2.0));
          
          if (C > maxChroma * 0.7) {
              float knee = maxChroma * 0.7;
              C = knee + (maxChroma - knee) * tanh((C - knee) / (maxChroma - knee + 0.001));
          }
          
          return clamp(oklabToLinear(vec3(L, C * cos(h), C * sin(h))), 0.0, 1.0);
      }
      
      vec3 applyContrastSaturation(vec3 linearRgb, float contrast, float saturation) {
          vec3 lab = linearToOklab(linearRgb);
          float C = length(lab.yz);
          float h = atan(lab.z, lab.y);
          
          lab.x = clamp((lab.x - 0.5) * contrast + 0.5, 0.0, 1.0);
          C *= saturation;
          lab.y = C * cos(h);
          lab.z = C * sin(h);
          
          return oklabToLinear(lab);
      }
      
      void main() {
          vec2 fragCoord = v_uv * u_resolution;
          vec2 r = u_resolution;
          vec2 p = (fragCoord * 2.0 - r) / r.y;
          
          int colorCount = u_colors_length;
          
          if (colorCount < 1) {
              fragColor = vec4(0.0, 0.0, 0.0, 1.0);
              return;
          }
      
          float t = u_time * 0.3;
          
          float looping = step(0.5, u_loop);
          float phase = TAU * u_time / max(u_loop, 0.01);
          float radius = u_loop * u_speed * 0.3 / TAU;
          float tA = sin(phase) * radius;
          float tB = (1.0 - cos(phase)) * radius;
          
          vec3 seedOffset = seedRandom(u_seed);
          vec3 seedOffset2 = seedRandom(u_seed + 100.0);
          
          float seedAngle = u_seed * GOLDEN_ANGLE;
          vec2 seedPhase = (seedOffset2.xy - 0.5) * TAU;
          
          float cs = cos(seedAngle);
          float sn = sin(seedAngle);
          p = mat2(cs, -sn, sn, cs) * p;
          
          float dither = getDither(floor(fragCoord / u_pixelRatio), u_ditherMode);
          
          float totalVal = 0.0;
          float totalWeight = 0.0;
          int turbIter = int(u_turbIter);
          
          float freq = 1.0 / max(u_turbFreq, 0.01);
          
          for (float i = 0.0; i < 4.0; i++) {
              float eph = i / 4.0;
             
              vec2 q = p * u_scale;
              float sq = eph * eph;
              
              if (u_jellify > 0.5) {
                  q.yx *= mix(1.0, 0.5, 1.0 - exp(-sq));
              }
              
              float a = seedPhase.x;
              float d = seedPhase.y;
              
              for (int j = 2; j < 13; j++) {
                  if (j >= turbIter) break;
                  float fj = float(j);
                  float t1 = mix(t * u_speed, tA, looping);
                  float t2 = mix(t * u_speed, tB, looping);
                  q += u_turbAmp * sin(q.yx / freq * fj + t1 + vec2(a, d) + seedOffset.xy * fj) / fj;
                  a += cos(fj + d * 1.2 + q.x * 2.0 - t1 + seedOffset2.z + t2 * 0.3 * looping);
                  d += sin(fj * q.y + a + seedOffset.z + t1 + seedOffset2.y + t2 * 0.3 * looping);
              }
              
              float v = 0.5 + 0.5 * sin(length(q.yx + vec2(a, d) * 0.2) * u_waveFreq + i * i + seedOffset.x);
              float weight = smoothstep(0.0, 0.5, eph) * smoothstep(1.0, 0.5, eph);
              totalVal += v * weight;
              totalWeight += weight;
          }
          
          float val = totalVal / totalWeight;
          val = clamp((val - 0.3) / 0.4, 0.0, 1.0);
          val = pow(val, exp(-u_distBias));
          val = clamp(val + (dither - 0.5) * u_dither, 0.0, 1.0);
          
          vec3 col = paletteN(val, colorCount);
          col *= u_exposure;
          col = applyContrastSaturation(col, u_contrast, u_saturation);
          col = softGamutMap(col);
          col = toSrgb(col);
          
          fragColor = vec4(col, 1.0);
      }
    `;

    const vs = gl.createShader(gl.VERTEX_SHADER);
    gl.shaderSource(vs, vsSource);
    gl.compileShader(vs);
    if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
      console.error("VS compilation error:", gl.getShaderInfoLog(vs));
      return;
    }

    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    gl.shaderSource(fs, fsSource);
    gl.compileShader(fs);
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
      console.error("FS compilation error:", gl.getShaderInfoLog(fs));
      return;
    }

    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      console.error("Program link error:", gl.getProgramInfoLog(program));
      return;
    }

    this.program = program;
    this.positionAttributeLocation = gl.getAttribLocation(program, "a_position");

    this.uniforms = {
      resolution: gl.getUniformLocation(program, "u_resolution"),
      time: gl.getUniformLocation(program, "u_time"),
      pixelRatio: gl.getUniformLocation(program, "u_pixelRatio"),
      colors: gl.getUniformLocation(program, "u_colors"),
      colorsLength: gl.getUniformLocation(program, "u_colors_length"),
      seed: gl.getUniformLocation(program, "u_seed"),
      speed: gl.getUniformLocation(program, "u_speed"),
      loop: gl.getUniformLocation(program, "u_loop"),
      scale: gl.getUniformLocation(program, "u_scale"),
      turbAmp: gl.getUniformLocation(program, "u_turbAmp"),
      turbFreq: gl.getUniformLocation(program, "u_turbFreq"),
      turbIter: gl.getUniformLocation(program, "u_turbIter"),
      waveFreq: gl.getUniformLocation(program, "u_waveFreq"),
      distBias: gl.getUniformLocation(program, "u_distBias"),
      jellify: gl.getUniformLocation(program, "u_jellify"),
      ditherMode: gl.getUniformLocation(program, "u_ditherMode"),
      dither: gl.getUniformLocation(program, "u_dither"),
      exposure: gl.getUniformLocation(program, "u_exposure"),
      contrast: gl.getUniformLocation(program, "u_contrast"),
      saturation: gl.getUniformLocation(program, "u_saturation"),
    };

    const positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1.0, -1.0, 1.0, -1.0, -1.0, 1.0, -1.0, 1.0, 1.0, -1.0, 1.0, 1.0]),
      gl.STATIC_DRAW
    );

    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.enableVertexAttribArray(this.positionAttributeLocation);
    gl.vertexAttribPointer(this.positionAttributeLocation, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  render(timeMs) {
    const gl = this.gl;
    if (!gl || !this.program) return;

    const time = timeMs * 0.001;
    gl.viewport(0, 0, gl.canvas.width, gl.canvas.height);

    gl.clearColor(0.0, 0.0, 0.0, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);

    gl.uniform2f(this.uniforms.resolution, gl.canvas.width, gl.canvas.height);
    gl.uniform1f(this.uniforms.time, time);
    gl.uniform1f(this.uniforms.pixelRatio, this.pixelRatio);

    const flattenedColors = new Float32Array(8 * 4);
    for (let i = 0; i < 8; i++) {
      const col = this.params.colors[i] || [0.0, 0.0, 0.0, 1.0];
      flattenedColors[i * 4 + 0] = col[0];
      flattenedColors[i * 4 + 1] = col[1];
      flattenedColors[i * 4 + 2] = col[2];
      flattenedColors[i * 4 + 3] = col[3];
    }
    gl.uniform4fv(this.uniforms.colors, flattenedColors);
    gl.uniform1i(this.uniforms.colorsLength, this.params.colors.length);

    gl.uniform1f(this.uniforms.seed, this.params.seed);
    gl.uniform1f(this.uniforms.speed, this.params.speed);
    gl.uniform1f(this.uniforms.loop, this.params.loop);
    gl.uniform1f(this.uniforms.scale, this.params.scale);
    gl.uniform1f(this.uniforms.turbAmp, this.params.turbAmp);
    gl.uniform1f(this.uniforms.turbFreq, this.params.turbFreq);
    gl.uniform1f(this.uniforms.turbIter, this.params.turbIter);
    gl.uniform1f(this.uniforms.waveFreq, this.params.waveFreq);
    gl.uniform1f(this.uniforms.distBias, this.params.distBias);
    gl.uniform1f(this.uniforms.jellify, this.params.jellify);
    gl.uniform1f(this.uniforms.ditherMode, this.params.ditherMode);
    gl.uniform1f(this.uniforms.dither, this.params.dither);
    gl.uniform1f(this.uniforms.exposure, this.params.exposure);
    gl.uniform1f(this.uniforms.contrast, this.params.contrast);
    gl.uniform1f(this.uniforms.saturation, this.params.saturation);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
  }
}

// ── PRELOADER ──────────────────────────────────────────────────────────
class PreloaderController {
  constructor() {
    this.wrapper = document.getElementById("loadingWrapper");
    this.countdown = document.getElementById("countdown");
    this.duration = 2200; // ms
    this.startTime = null;
    this._run();
  }

  _ease(t) {
    return 1 - Math.pow(1 - t, 3);
  }

  _run() {
    const tick = (now) => {
      if (!this.startTime) this.startTime = now;
      const elapsed = now - this.startTime;
      const progress = Math.min(elapsed / this.duration, 1);
      const pct = Math.round(this._ease(progress) * 100);

      if (this.countdown) this.countdown.textContent = pct + "%";

      if (progress < 1) {
        requestAnimationFrame(tick);
      } else {
        this._finish();
      }
    };
    requestAnimationFrame(tick);
  }

  _finish() {
    // Allow body scroll
    document.body.classList.remove("is-loading");

    // Initialize all components first (Lenis, Nav, Animations, etc.)
    AppController.afterLoad(false);

    if (this.wrapper) {
      // Coordinated timeline for slide-up and reveal
      const tl = gsap.timeline({
        onComplete: () => {
          if (this.wrapper) this.wrapper.remove();
          setTimeout(() => {
            ScrollTrigger.refresh();
          }, 150);
          const hash = window.location.hash;
          if (hash) {
            const target = document.querySelector(hash);
            if (target && window.__lenis) {
              window.__lenis.scrollTo(target, { duration: 1.2, offset: -72 });
            }
          }
        },
      });

      // Slide up preloader wrapper
      tl.to(this.wrapper, {
        yPercent: -100,
        duration: 1.4,
        ease: "power4.inOut",
      });

      // Trigger coordinated reveal animations
      if (window.__animationsInstance) {
        window.__animationsInstance.triggerSiteReveal(tl);
      }
    } else {
      if (window.__animationsInstance) {
        window.__animationsInstance.triggerSiteReveal();
      }
    }
  }
}
// ── CURSOR (Porto-style: GSAP quickTo for ultra-smooth lag) ─────────────
class Cursor {
  constructor() {
    this.cursor = q("#cursor");
    if (!this.cursor) return;
    this.init();
  }

  init() {
    const xTo = gsap.quickTo(this.cursor, "x", { duration: 0.25, ease: "power3.out" });
    const yTo = gsap.quickTo(this.cursor, "y", { duration: 0.25, ease: "power3.out" });

    gsap.set(this.cursor, { xPercent: -50, yPercent: -50 });

    document.addEventListener("mousemove", (e) => {
      xTo(e.clientX);
      yTo(e.clientY);
    });

    const hovers =
      "a, button, .work-row, .spec-item, .contact-big-btn, .hero-right-cta, .avail-badge, .footer-cta, .portfolio-card";
    qq(hovers).forEach((el) => {
      el.addEventListener("mouseenter", () => {
        this.cursor.classList.add("hovered");
      });
      el.addEventListener("mouseleave", () => {
        this.cursor.classList.remove("hovered");
      });
    });

    document.addEventListener("mouseleave", () => {
      gsap.to(this.cursor, { opacity: 0, duration: 0.2 });
    });
    document.addEventListener("mouseenter", () => {
      gsap.to(this.cursor, { opacity: 1, duration: 0.2 });
    });
  }
}

// ── LENIS SMOOTH SCROLL ─────────────────────────────────────────────────
class Smooth {
  constructor() {
    this.lenis = null;
  }

  init() {
    if (typeof Lenis === "undefined") return;

    this.lenis = new Lenis({
      lerp: 0.08,
      smoothWheel: true,
      syncTouch: false,
    });

    this.lenis.on("scroll", ScrollTrigger.update);

    gsap.ticker.add((time) => {
      this.lenis.raf(time * 1000);
    });
    gsap.ticker.lagSmoothing(0);

    return this.lenis;
  }
}

// ── NAV ─────────────────────────────────────────────────────────────────
class Nav {
  constructor() {
    this.nav = q("#nav");
    this.burger = q("#navBurger");
    this.mob = q("#mobMenu");
    this.navLinksContainer = q(".nav-links-custom");
    this.open = false;
    this.init();
    this.initFloatingUnderline();
  }

  init() {
    // Burger — safety check for project pages that may not have mobile menu
    if (this.burger) {
      this.burger.addEventListener("click", () => this.toggleMob());
    }

    // Close mob on link click
    qq(".mob-link, .nav-link-custom").forEach((a) => a.addEventListener("click", () => this.closeMob()));

    // Scroll-based nav bg intensify
    if (this.nav) {
      ScrollTrigger.create({
        start: 80,
        onEnter: () => this.nav.classList.add("scrolled"),
        onLeaveBack: () => this.nav.classList.remove("scrolled"),
      });
    }
  }

  initFloatingUnderline() {
    if (!this.navLinksContainer) return;

    let underline = this.navLinksContainer.querySelector(".nav-underline-floating");
    if (!underline) {
      underline = document.createElement("div");
      underline.className = "nav-underline-floating";
      this.navLinksContainer.appendChild(underline);
    }

    const links = this.navLinksContainer.querySelectorAll(".nav-link-custom");

    const update = (link) => {
      if (!link) {
        underline.style.opacity = "0";
        underline.style.width = "0px";
        return;
      }
      const parentRect = this.navLinksContainer.getBoundingClientRect();
      const linkRect = link.getBoundingClientRect();
      const left = linkRect.left - parentRect.left;
      underline.style.left = `${left}px`;
      underline.style.width = `${linkRect.width}px`;
      underline.style.opacity = "1";
    };

    links.forEach((link) => {
      link.addEventListener("mouseenter", () => update(link));
    });

    this.navLinksContainer.addEventListener("mouseleave", () => {
      const activeLink = this.getActiveLink();
      update(activeLink);
    });

    window.addEventListener("resize", () => {
      const activeLink = this.getActiveLink();
      update(activeLink);
    });

    // Scroll active section observer on homepage
    const currentPath = window.location.pathname;
    const isHome = currentPath.endsWith("index.html") || currentPath === "/" || currentPath.endsWith("/");

    if (isHome) {
      const sections = ["hero", "works", "about", "contact"];
      const observerOptions = {
        root: null,
        rootMargin: "-45% 0px -45% 0px",
        threshold: 0,
      };

      const observer = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            const id = entry.target.id;
            links.forEach((link) => {
              const href = link.getAttribute("href");
              if (href === `#${id}` || href.endsWith(`#${id}`)) {
                links.forEach((l) => l.classList.remove("active"));
                link.classList.add("active");
                // Only update position if mouse is not currently hovering over the links container
                const isHovered = this.navLinksContainer.matches(":hover");
                if (!isHovered) {
                  update(link);
                }
              }
            });
          }
        });
      }, observerOptions);

      sections.forEach((id) => {
        const el = document.getElementById(id);
        if (el) observer.observe(el);
      });
    }

    // Set initial position
    setTimeout(() => {
      const activeLink = this.getActiveLink();
      update(activeLink);
    }, 150);
  }

  getActiveLink() {
    if (!this.navLinksContainer) return null;
    const links = this.navLinksContainer.querySelectorAll(".nav-link-custom");
    const currentPath = window.location.pathname;
    const currentHash = window.location.hash;

    const isHome = currentPath.endsWith("index.html") || currentPath === "/" || currentPath.endsWith("/");

    if (isHome) {
      for (const link of links) {
        if (link.classList.contains("active")) {
          return link;
        }
      }
      if (currentHash) {
        for (const link of links) {
          const href = link.getAttribute("href");
          if (href === currentHash || href.endsWith(currentHash)) {
            return link;
          }
        }
      }
      return links[0]; // fallback to Home
    } else {
      for (const link of links) {
        const href = link.getAttribute("href");
        if (href && !href.startsWith("#") && currentPath.includes(href)) {
          return link;
        }
      }
    }
    return null;
  }

  toggleMob() {
    if (!this.burger || !this.mob) return;
    this.open = !this.open;
    this.burger.classList.toggle("open", this.open);
    this.mob.classList.toggle("show", this.open);
  }

  closeMob() {
    if (!this.burger || !this.mob) return;
    this.open = false;
    this.burger.classList.remove("open");
    this.mob.classList.remove("show");
  }
}

// ── GSAP ANIMATIONS ─────────────────────────────────────────────────────
class Animations {
  init() {
    gsap.registerPlugin(ScrollTrigger);

    // ── Scroll Parallax (3D sandwich)
    const bgImg = q("#heroBgImg");
    const fgImg = q("#heroFgImg");
    const titleOverlay = q("#heroTitleOverlay");

    if (bgImg) {
      gsap.to(bgImg, {
        yPercent: 12,
        ease: "none",
        scrollTrigger: {
          trigger: ".hero",
          start: "top top",
          end: "bottom top",
          scrub: true,
        },
      });
    }
    if (fgImg) {
      gsap.to(fgImg, {
        yPercent: 12,
        ease: "none",
        scrollTrigger: {
          trigger: ".hero",
          start: "top top",
          end: "bottom top",
          scrub: true,
        },
      });
    }
    if (titleOverlay) {
      gsap.to(titleOverlay, {
        yPercent: -25,
        ease: "none",
        scrollTrigger: {
          trigger: ".hero",
          start: "top top",
          end: "bottom top",
          scrub: true,
        },
      });
    }

    // ── Process Section Reveal
    const processSection = q(".process-section");
    if (processSection) {
      // Main title & sub-caption fade up
      const processTitle = q(".process-main-title");
      const processSub = q(".process-sub-caption");
      if (processTitle) {
        gsap.fromTo(
          processTitle,
          { y: 50, opacity: 0 },
          {
            y: 0,
            opacity: 1,
            duration: 1.2,
            ease: "power4.out",
            scrollTrigger: {
              trigger: processTitle,
              start: "top 85%",
            },
          }
        );
      }
      if (processSub) {
        gsap.fromTo(
          processSub,
          { y: 30, opacity: 0 },
          {
            y: 0,
            opacity: 1,
            duration: 1.2,
            delay: 0.15,
            ease: "power3.out",
            scrollTrigger: {
              trigger: processTitle,
              start: "top 85%",
            },
          }
        );
      }

      // Cards stagger reveal
      const processCards = qq(".process-card");
      if (processCards.length > 0) {
        gsap.fromTo(
          processCards,
          { y: 60, opacity: 0 },
          {
            y: 0,
            opacity: 1,
            duration: 1.2,
            stagger: 0.15,
            ease: "power3.out",
            scrollTrigger: {
              trigger: ".process-cards-row",
              start: "top 85%",
            },
          }
        );
      }
    }

    // Works slab and project grid animations are handled dynamically by WorksSlab and ProjectsGrid components.

    gsap.utils.toArray(".js-reveal-up").forEach((el) => {
      // Skip elements inside hero, since they are handled by the page entry reveal timeline
      if (el.closest(".hero")) return;

      gsap.fromTo(
        el,
        { opacity: 0, y: 30 },
        {
          opacity: 1,
          y: 0,
          duration: 1.0,
          ease: "expo.out",
          scrollTrigger: {
            trigger: el,
            start: "top 88%",
          },
        }
      );
    });

    // ── SCROLL reveals for big headers
    gsap.utils.toArray(".js-big-reveal").forEach((el) => {
      gsap.to(el, {
        opacity: 1,
        y: 0,
        duration: 1.1,
        ease: "expo.out",
        scrollTrigger: {
          trigger: el,
          start: "top 85%",
        },
      });
    });

    // ── Step reveals in About section
    gsap.utils.toArray(".js-step-reveal").forEach((el, i) => {
      gsap.to(el, {
        opacity: 1,
        y: 0,
        duration: 0.9,
        delay: i * 0.1,
        ease: "expo.out",
        scrollTrigger: {
          trigger: el.closest(".intro-steps") || el,
          start: "top 80%",
        },
      });
    });

    // ── Work rows entry reveal
    qq(".js-work-row").forEach((row, i) => {
      gsap.fromTo(
        row,
        { opacity: 0, x: -30 },
        {
          opacity: 1,
          x: 0,
          duration: 0.8,
          delay: i * 0.07,
          ease: "expo.out",
          scrollTrigger: {
            trigger: row,
            start: "top 88%",
          },
        }
      );
    });

    // ── Spec items
    qq(".spec-item").forEach((el, i) => {
      gsap.fromTo(
        el,
        { opacity: 0, y: 30 },
        {
          opacity: 1,
          y: 0,
          duration: 0.7,
          delay: i * 0.08,
          ease: "expo.out",
          scrollTrigger: {
            trigger: el.closest(".spec-grid") || el,
            start: "top 82%",
          },
        }
      );
    });

    // ── Contact headline
    qq(".contact-hl").forEach((el, i) => {
      gsap.fromTo(
        el,
        { y: "105%" },
        {
          y: 0,
          duration: 1,
          delay: i * 0.1,
          ease: "expo.out",
          scrollTrigger: {
            trigger: el.closest(".contact-headline-wrap") || el,
            start: "top 85%",
          },
        }
      );
    });

    // ── Work title horizontal text parallax
    const wtBlock = q(".work-title-block");
    if (wtBlock) {
      gsap.to(".line-selected", {
        xPercent: -15,
        ease: "none",
        scrollTrigger: {
          trigger: wtBlock,
          start: "top bottom",
          end: "bottom top",
          scrub: true,
        },
      });
      gsap.to(".line-works", {
        xPercent: 15,
        ease: "none",
        scrollTrigger: {
          trigger: wtBlock,
          start: "top bottom",
          end: "bottom top",
          scrub: true,
        },
      });
    }

    // ── Footer wordmark subtle parallax
    const fw = q(".footer-wordmark");
    if (fw) {
      gsap.to(fw, {
        y: -60,
        ease: "none",
        scrollTrigger: {
          trigger: q(".footer"),
          start: "top bottom",
          end: "bottom top",
          scrub: true,
        },
      });
    }

    // ── Voice of Ryuk (Scroll reveal + Parallax)
    const voiceSec = q(".voice-section");
    if (voiceSec) {
      // Split text into characters dynamically for character-by-character animation
      const voiceDesc = q("#voiceDesc");
      if (voiceDesc) {
        const lines = voiceDesc.querySelectorAll(".voice-line");
        lines.forEach((line) => {
          const text = line.textContent.trim();
          line.innerHTML = "";

          const words = text.split(" ");
          words.forEach((word, wordIdx) => {
            const wordSpan = document.createElement("span");
            wordSpan.style.display = "inline-block";
            wordSpan.style.whiteSpace = "nowrap";

            for (let i = 0; i < word.length; i++) {
              const char = word[i];
              const span = document.createElement("span");
              span.textContent = char;
              span.className = "voice-char";
              wordSpan.appendChild(span);
            }
            line.appendChild(wordSpan);

            if (wordIdx < words.length - 1) {
              const spaceSpan = document.createElement("span");
              spaceSpan.innerHTML = "&nbsp;";
              spaceSpan.className = "voice-char-space";
              line.appendChild(spaceSpan);
            }
          });
        });
      }

      const voiceChars = qq(".voice-char");
      if (voiceChars.length > 0) {
        gsap.fromTo(
          voiceChars,
          { opacity: 0.1, y: 15 },
          {
            opacity: 1,
            y: 0,
            duration: 0.6,
            ease: "power3.out",
            stagger: 0.012, // Fast premium stagger
            scrollTrigger: {
              trigger: ".voice-section",
              start: "top 75%",
              toggleActions: "play none none none",
            },
          }
        );
      }

      const voiceSig = q("#voiceSignature");
      if (voiceSig) {
        gsap.fromTo(
          voiceSig,
          { opacity: 0, y: 15 },
          {
            opacity: 1,
            y: 0,
            duration: 0.8,
            ease: "power3.out",
            scrollTrigger: {
              trigger: ".voice-section",
              start: "top 70%",
              toggleActions: "play none none none",
            },
          }
        );
      }

      const wrappers = qq(".gallery-img-wrapper");
      wrappers.forEach((wrap, index) => {
        // 1. Inner image scale & translation parallax (completely safe for all screens including mobile)
        const img = wrap.querySelector("img");
        if (img) {
          gsap.fromTo(
            img,
            { scale: 1.25, yPercent: -6 },
            {
              scale: 1.25,
              yPercent: 6,
              scrollTrigger: {
                trigger: wrap,
                start: "top bottom",
                end: "bottom top",
                scrub: true,
              },
            }
          );
        }

        // 2. Outer wrapper staggered vertical translation parallax for depth (desktop only to prevent mobile grid overlap glitches)
        if (window.innerWidth > 809) {
          const isEven = index % 2 === 0;
          const yStart = isEven ? 50 : -50;
          const yEnd = isEven ? -50 : 50;

          gsap.fromTo(
            wrap,
            { y: yStart },
            {
              y: yEnd,
              scrollTrigger: {
                trigger: wrap,
                start: "top bottom",
                end: "bottom top",
                scrub: true,
              },
            }
          );
        }
      });
    }
  }

  // ── Unified Site Reveal Timeline
  triggerSiteReveal(parentTl = null) {
    const revealTl = parentTl || gsap.timeline();

    const nav = q(".nav-floating");
    const shaderWrapper = q(".hero-shader-wrapper");

    const leftAddress = q(".hero-left-address");
    const rightEstablished = q(".hero-right-established");
    const yearBadge = q(".hero-year-badge");
    const heroTitle = q(".hero-title");
    const servicesRow = q(".hero-services-row");
    const bottomDesc = q(".hero-bottom-desc");

    // Wrap letters of RYUK* in spans for character-by-character clip reveal
    if (heroTitle && !heroTitle.querySelector(".hero-title-char")) {
      const text = heroTitle.textContent.trim();
      heroTitle.innerHTML = "";
      for (let i = 0; i < text.length; i++) {
        const char = text[i];
        const wrapper = document.createElement("span");
        wrapper.style.display = "inline-block";
        wrapper.style.overflow = "hidden";
        wrapper.style.verticalAlign = "bottom";

        const span = document.createElement("span");
        span.textContent = char;
        span.className = "hero-title-char";
        if (char === "®") {
          span.classList.add("logo-reg");
        }
        span.style.display = "inline-block";
        span.style.transform = "translateY(100%)";

        wrapper.appendChild(span);
        heroTitle.appendChild(wrapper);
      }
    }

    // 1. Canvas shader wrapper fade-in
    if (shaderWrapper) {
      revealTl.fromTo(shaderWrapper, { opacity: 0 }, { opacity: 1, duration: 2.0, ease: "power2.out" }, "0.0");
    }

    // 2. Nav slides down
    if (nav) {
      revealTl.fromTo(
        nav,
        { y: -20, opacity: 0 },
        { y: 0, opacity: 1, duration: 1.2, ease: "power4.out" },
        parentTl ? "-=1.2" : "0.1"
      );

      const navEls = qq("#nav .nav-logo-custom, #nav .nav-link-custom, #nav .nav-cta-btn, #nav .nav-burger-custom");
      if (navEls.length > 0) {
        revealTl.fromTo(
          navEls,
          { y: -8, opacity: 0 },
          { y: 0, opacity: 1, duration: 0.8, stagger: 0.05, ease: "power3.out" },
          parentTl ? "-=1.0" : "0.2"
        );
      }
    }

    // 3. Year badge reveal
    if (yearBadge) {
      revealTl.fromTo(
        yearBadge,
        { y: 10, opacity: 0 },
        { y: 0, opacity: 1, duration: 0.8, ease: "power3.out" },
        parentTl ? "-=0.9" : "0.35"
      );
    }

    // 4. Staggered character reveal of RYUK*
    const titleChars = qq(".hero-title-char");
    if (titleChars.length > 0) {
      revealTl.to(
        titleChars,
        {
          y: "0%",
          duration: 1.4,
          stagger: 0.06,
          ease: "power4.out",
        },
        parentTl ? "-=0.8" : "0.4"
      );
    }

    // 5. Services row reveal
    if (servicesRow) {
      revealTl.fromTo(
        servicesRow,
        { y: 15, opacity: 0 },
        { y: 0, opacity: 1, duration: 1.0, ease: "power3.out" },
        parentTl ? "-=0.6" : "0.65"
      );
    }

    // 6. Left side address and right side established reveals
    if (leftAddress) {
      revealTl.fromTo(
        leftAddress,
        { x: -20, opacity: 0 },
        { x: 0, opacity: 1, duration: 1.2, ease: "power3.out" },
        parentTl ? "-=0.5" : "0.75"
      );
    }
    if (rightEstablished) {
      revealTl.fromTo(
        rightEstablished,
        { x: 20, opacity: 0 },
        { x: 0, opacity: 1, duration: 1.2, ease: "power3.out" },
        parentTl ? "-=1.2" : "0.75"
      );
    }

    // 7. Bottom left description paragraph reveal
    if (bottomDesc) {
      revealTl.fromTo(
        bottomDesc,
        { y: 20, opacity: 0 },
        { y: 0, opacity: 1, duration: 1.2, ease: "power3.out" },
        parentTl ? "-=0.4" : "0.9"
      );
    }
  }
}

// ── FLOATING HOVER REVEAL ───────────────────────────────────────────────
function initHoverReveal() {
  const isMobile = window.innerWidth <= 768;
  if (isMobile) return;

  // Create floating container if it doesn't exist
  let reveal = q(".hover-reveal");
  if (!reveal) {
    reveal = document.createElement("div");
    reveal.className = "hover-reveal";
    const revealImg = document.createElement("img");
    revealImg.className = "hover-reveal-img";
    reveal.appendChild(revealImg);
    document.body.appendChild(reveal);
  }

  const revealImg = q(".hover-reveal-img", reveal);
  let mouseX = 0,
    mouseY = 0;
  let currentX = 0,
    currentY = 0;
  let rotate = 0,
    targetRotate = 0;

  document.addEventListener("mousemove", (e) => {
    mouseX = e.clientX;
    mouseY = e.clientY;
  });

  // Smooth LERP render loop
  function render() {
    const dx = mouseX - currentX;
    const dy = mouseY - currentY;
    currentX += dx * 0.085;
    currentY += dy * 0.085;

    // Rotate based on horizontal speed
    targetRotate = dx * 0.12;
    targetRotate = Math.min(Math.max(targetRotate, -10), 10);
    rotate += (targetRotate - rotate) * 0.08;

    reveal.style.left = currentX + "px";
    reveal.style.top = currentY + "px";
    reveal.style.transform = `translate(-50%, -50%) rotate(${rotate}deg)`;

    requestAnimationFrame(render);
  }
  requestAnimationFrame(render);

  // Hover states for work rows
  qq(".js-work-row").forEach((row) => {
    row.addEventListener("mouseenter", () => {
      const imgUrl = row.getAttribute("data-img");
      if (imgUrl && revealImg) {
        revealImg.src = imgUrl;
      }
      gsap.to(reveal, {
        opacity: 1,
        scale: 1,
        duration: 0.35,
        ease: "power3.out",
      });
    });

    row.addEventListener("mouseleave", () => {
      gsap.to(reveal, {
        opacity: 0,
        scale: 0.6,
        duration: 0.3,
        ease: "power3.inOut",
      });
    });

    row.addEventListener("click", (e) => {
      // If the user clicked an actual link (e.g. the view case button directly), do not double trigger
      if (e.target.closest("a")) return;
      const link = row.querySelector("a");
      if (link) {
        link.click();
      }
    });
  });
}

// ── MAGNETIC ELEMENTS (Porto-style: elastic spring return) ─────────────
function initMagnetic() {
  const isMobile = window.innerWidth <= 768;
  if (isMobile) return;

  const targets = qq(".hero-right-cta, .contact-big-btn, .nav-link, .avail-badge, .footer-cta");
  targets.forEach((el) => {
    el.addEventListener("mousemove", (e) => {
      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const dx = (e.clientX - cx) * 0.28;
      const dy = (e.clientY - cy) * 0.28;
      gsap.to(el, { x: dx, y: dy, duration: 0.4, ease: "power2.out", overwrite: "auto" });
    });
    el.addEventListener("mouseleave", () => {
      gsap.to(el, { x: 0, y: 0, duration: 0.8, ease: "elastic.out(1, 0.4)", overwrite: "auto" });
    });
  });
}

// ── SCROLL-LINKED LINE CLIP reveals (Porto word-by-word) ─────────────
function initScrollRevealLines() {
  // Wrap each .js-big-reveal in an overflow:hidden container if not already
  qq(".js-big-reveal").forEach((el) => {
    if (el.closest(".hero")) return; // hero handled separately
    // Already handled by existing GSAP in Animations.init, just ensure smooth easing
  });

  // Staggered stat counters / numbers on scroll
  qq(".js-stat").forEach((el) => {
    const target = parseInt(el.dataset.target || el.textContent, 10);
    if (isNaN(target)) return;
    el.textContent = "0";
    gsap.to(el, {
      innerText: target,
      duration: 1.8,
      ease: "power3.out",
      snap: { innerText: 1 },
      scrollTrigger: {
        trigger: el,
        start: "top 85%",
      },
    });
  });
}

// ── WORK ROW HOVER TILT (Porto card 3D tilt) ─────────────────────
function initWorkRowTilt() {
  const isMobile = window.innerWidth <= 768;
  if (isMobile) return;

  qq(".work-row").forEach((row) => {
    row.style.perspective = "800px";

    row.addEventListener("mousemove", (e) => {
      const rect = row.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width - 0.5) * 10;
      const y = ((e.clientY - rect.top) / rect.height - 0.5) * -6;
      gsap.to(row, {
        rotateX: y,
        rotateY: x,
        transformOrigin: "center center",
        duration: 0.5,
        ease: "power2.out",
        overwrite: "auto",
      });
    });

    row.addEventListener("mouseleave", () => {
      gsap.to(row, {
        rotateX: 0,
        rotateY: 0,
        duration: 0.8,
        ease: "elastic.out(1, 0.5)",
        overwrite: "auto",
      });
    });
  });
}

// ── BUTTON HOVER FILL SLIDE (Porto CTA button fill sweep) ─────────
function initButtonFill() {
  qq(".contact-big-btn, .btn-primary").forEach((btn) => {
    // Ensure the button has position:relative for the pseudo-element to anchor
    if (getComputedStyle(btn).position === "static") {
      btn.style.position = "relative";
    }

    // Create fill element
    const fill = document.createElement("span");
    fill.style.cssText = `
      position: absolute;
      inset: 0;
      background: rgba(255,51,0,0.08);
      transform: scaleX(0);
      transform-origin: left center;
      pointer-events: none;
      border-radius: inherit;
      z-index: 0;
    `;
    btn.appendChild(fill);

    btn.addEventListener("mouseenter", () => {
      gsap.to(fill, { scaleX: 1, duration: 0.45, ease: "power3.out" });
    });
    btn.addEventListener("mouseleave", () => {
      gsap.to(fill, { scaleX: 0, transformOrigin: "right center", duration: 0.35, ease: "power3.inOut" });
    });
  });
}

// ── HERO 3D MOUSE PARALLAX ──────────────────────────────────────────────
function initHero3DParallax() {
  const hero = q(".hero");
  const centerGroup = q(".hero-center-group");
  const leftAddress = q(".hero-left-address");
  const rightEstablished = q(".hero-right-established");
  const bottomDesc = q(".hero-bottom-desc");

  if (!hero) return;

  const isMobile = window.innerWidth <= 768;
  if (isMobile) return;

  hero.addEventListener("mousemove", (e) => {
    const { width, height, left, top } = hero.getBoundingClientRect();
    const mouseX = e.clientX - left;
    const mouseY = e.clientY - top;

    const normX = mouseX / width - 0.5;
    const normY = mouseY / height - 0.5;

    if (centerGroup) {
      gsap.to(centerGroup, {
        x: normX * 16,
        y: normY * 16,
        duration: 0.8,
        ease: "power2.out",
        overwrite: "auto",
      });
    }
    if (leftAddress) {
      gsap.to(leftAddress, {
        x: normX * -10,
        yPercent: -50,
        y: normY * -10,
        duration: 0.8,
        ease: "power2.out",
        overwrite: "auto",
      });
    }
    if (rightEstablished) {
      gsap.to(rightEstablished, {
        x: normX * -10,
        yPercent: -50,
        y: normY * -10,
        duration: 0.8,
        ease: "power2.out",
        overwrite: "auto",
      });
    }
    if (bottomDesc) {
      gsap.to(bottomDesc, {
        x: normX * 24,
        y: normY * 24,
        duration: 0.8,
        ease: "power2.out",
        overwrite: "auto",
      });
    }
  });

  hero.addEventListener("mouseleave", () => {
    const resetTargets = [
      { el: centerGroup, x: 0, y: 0, yp: 0 },
      { el: leftAddress, x: 0, y: 0, yp: -50 },
      { el: rightEstablished, x: 0, y: 0, yp: -50 },
      { el: bottomDesc, x: 0, y: 0, yp: 0 },
    ];
    resetTargets.forEach((t) => {
      if (t.el) {
        gsap.to(t.el, {
          x: t.x,
          y: t.y,
          yPercent: t.yp,
          duration: 1.2,
          ease: "power2.out",
          overwrite: "auto",
        });
      }
    });
  });
}

// ── PAGE TRANSITIONS ────────────────────────────────────────────────────
class PageTransition {
  constructor(skipReveal) {
    this.init(skipReveal);
  }

  init(skipReveal) {
    const pageContent = q("#pageContent");
    if (pageContent && !skipReveal) {
      // Entrance animation: fade in and slide up
      gsap.fromTo(
        pageContent,
        { opacity: 0, y: 30 },
        {
          opacity: 1,
          y: 0,
          duration: 0.65,
          ease: "power3.out",
          clearProps: "transform,opacity",
        }
      );
    }

    // Intercept internal links using event delegation
    if (!window.__pjaxClickBound) {
      document.addEventListener("click", (e) => {
        const a = e.target.closest("a");
        if (!a) return;
        const href = a.getAttribute("href");

        if (href && !href.startsWith("mailto:") && !href.startsWith("tel:") && a.getAttribute("target") !== "_blank") {
          // Check if it's an internal link
          try {
            const url = new URL(href, window.location.href);
            const isSamePage = url.pathname === window.location.pathname && url.search === window.location.search;
            const isInternal = url.origin === window.location.origin;

            if (isInternal) {
              if (!isSamePage) {
                // Different page -> Load page via PJAX transition
                e.preventDefault();
                this.loadPage(href, true);
              } else if (url.hash) {
                // Same page with hash -> Smooth scroll using Lenis if possible
                const target = document.querySelector(url.hash);
                if (target) {
                  e.preventDefault();
                  if (window.__lenis) {
                    window.__lenis.scrollTo(target, { duration: 1.2, offset: -72 });
                  } else {
                    target.scrollIntoView({ behavior: "smooth" });
                  }
                }
              }
            }
          } catch (err) {
            // Invalid URL -> Let native browser action take place
          }
        }
      });
      window.__pjaxClickBound = true;
    }

    // Handle back/forward buttons
    if (!window.__popstateBound) {
      window.addEventListener("popstate", () => {
        this.loadPage(window.location.href, false);
      });
      window.__popstateBound = true;
    }
  }

  async loadPage(href, push = true) {
    const pageContent = q("#pageContent");
    if (!pageContent) {
      window.location.href = href;
      return;
    }

    // Hide hover reveal card instantly
    const reveal = q(".hover-reveal");
    if (reveal) reveal.style.opacity = "0";

    try {
      // 1. Parallel fetch and exit animation for extreme responsiveness
      const fetchPromise = fetch(href).then((res) => res.text());

      const exitAnimPromise = gsap.to(pageContent, {
        opacity: 0,
        y: -30,
        duration: 0.35,
        ease: "power2.inOut",
      });

      // Wait for both the fetch and the animation to finish
      const [htmlText] = await Promise.all([fetchPromise, exitAnimPromise]);

      // 2. Parse HTML
      const parser = new DOMParser();
      const doc = parser.parseFromString(htmlText, "text/html");
      const newContent = doc.querySelector("#pageContent");

      if (!newContent) {
        window.location.href = href;
        return;
      }

      // 3. Swap content and update path
      pageContent.innerHTML = newContent.innerHTML;
      document.title = doc.title;
      document.body.className = doc.body.className;

      if (push) {
        history.pushState(null, "", href);
      }

      // 4. Kill previous ScrollTrigger instances and Lenis instance
      if (window.ScrollTrigger) {
        ScrollTrigger.getAll().forEach((t) => t.kill());
      }
      if (window.__lenis) {
        window.__lenis.destroy();
      }

      // 5. Extract and execute inline scripts on the new page
      const scriptTags = doc.querySelectorAll("script:not([src])");
      scriptTags.forEach((s) => {
        const newScript = document.createElement("script");
        newScript.textContent = s.textContent;
        document.body.appendChild(newScript);
        newScript.remove();
      });

      // Determine page type
      const isProjectPage = href.includes("project") || href.includes("nestora") || href.includes("theroom");

      // 6. Re-initialize all global modules (Lenis, ScrollTrigger, Nav, cursor, magnetic, tilt, etc.)
      AppController.afterLoad(isProjectPage);

      // Execute project-specific animations
      setTimeout(() => {
        if (typeof window.__projectInit === "function") {
          window.__projectInit();
        } else if (typeof initProjectAnimations === "function") {
          initProjectAnimations();
        }
      }, 50);

      // 7. Extract the hash from URL to scroll if present
      const url = new URL(href, window.location.href);
      const hash = url.hash;
      if (hash) {
        setTimeout(() => {
          const target = document.querySelector(hash);
          if (target && window.__lenis) {
            window.__lenis.scrollTo(target, { duration: 1.2, offset: -72 });
          } else if (target) {
            target.scrollIntoView({ behavior: "smooth" });
          }
        }, 150);
      } else {
        window.scrollTo(0, 0);
      }

      // 8. Entrance animation: fade in and slide up
      gsap.fromTo(
        pageContent,
        { opacity: 0, y: 30 },
        {
          opacity: 1,
          y: 0,
          duration: 0.6,
          ease: "power3.out",
          clearProps: "transform,opacity",
        }
      );
    } catch (err) {
      console.error("PJAX navigation failed, falling back to reload:", err);
      window.location.href = href;
    }
  }
}

// ── BACK TO TOP ─────────────────────────────────────────────────────────
const backTopBtn = q("#backTop");
if (backTopBtn) {
  backTopBtn.addEventListener("click", () => {
    if (window.__lenis) {
      window.__lenis.scrollTo(0, { duration: 1.4 });
    } else {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  });
}

// ── SMOOTH ANCHOR SCROLLING ─────────────────────────────────────────────
function initAnchors(lenis) {
  qq('a[href^="#"]').forEach((a) => {
    a.addEventListener("click", (e) => {
      const id = a.getAttribute("href").slice(1);
      const target = document.getElementById(id);
      if (!target) return;
      e.preventDefault();
      if (lenis) {
        lenis.scrollTo(target, { duration: 1.2, offset: -72 });
      } else {
        target.scrollIntoView({ behavior: "smooth" });
      }
    });
  });
}

// ── SELECTED WORKS COMPONENTS (Ylli Ramadani Snap-Lock Scroll & Flipbook Grid) ──
const M = "cubic-bezier(0.76, 0.0, 0.24, 1.0)";
const E = [
  { clipPath: "polygon(0 0, 100% 0, 100% 0, 0 0)", transform: "translateY(100%)" },
  { clipPath: "polygon(0 0, 100% 0, 100% 105%, 0 105%)", transform: "translateY(0)" },
];
const G = { duration: 1500, fill: "forwards", easing: M };
const w = { duration: 800, fill: "forwards", easing: M };

class SectionComponent {
  constructor(element, options = { rootMargin: "0px", threshold: 0.3 }) {
    this.element = element;
    this.options = options;
    this.isAnimating = false;
    this._initObserver();
  }

  _setupApp() {}

  _initObserver() {
    this.observer = new IntersectionObserver((entries) => this._handleIntersect(entries), this.options);
    if (this.element) this.observer.observe(this.element);
  }

  _handleIntersect(entries) {
    const [entry] = entries;
    if (entry.isIntersecting) {
      // this._lockScroll();
      if (!this.isAnimating) {
        this.isAnimating = true;
        this.onEnter();
      }
    }
  }

  _lockScroll() {
    const isDesktop = window.innerWidth >= 650;
    if (isDesktop && window.__lenis && this.element) {
      window.__lenis.scrollTo(this.element, { lock: true, force: true });
    }
  }

  onEnter() {}
}

class WorksSlab extends SectionComponent {
  constructor(element) {
    super(element);
    this._initElements();
  }

  _initElements() {
    this.letters = this.element.querySelectorAll(".works-letters");
  }

  _setInitialState() {
    this.letters.forEach((t) => (t.style.opacity = 0));
  }

  _animateLetters() {
    this.letters.forEach((t, i) => {
      setTimeout(() => {
        t.style.opacity = 1;
        t.animate(E, w);
      }, i * 20);
    });
  }

  onEnter() {
    this._setInitialState();
    this._animateLetters();
  }
}

const tt = [
  {
    class: "projects-top",
    projects: [
      {
        id: "nestora",
        type: "wide",
        alt: "Nestora Studio Interior Design",
        count: 5,
        title: "Nestora Studio / Interior Design",
        url: "nestora.html",
        format: "jpg",
      },
      {
        id: "theroom",
        type: "tall",
        alt: "The Room Luxury Restaurant",
        count: 5,
        title: "The Room / Luxury Restaurant",
        url: "theroom.html",
        format: "jpg",
      },
    ],
  },
  {
    class: "projects-middle",
    projects: [
      {
        id: "appsee",
        type: "tall",
        alt: "Appsee Polish SaaS Explainer",
        isVideo: false,
        count: 1,
        format: "png",
        title: "Appsee Polish / SaaS Explainer",
        url: "https://drive.google.com/file/d/1vW-AVdYLL7Zd2K6NZJ8fvZ1k_r3s1S2V/view?usp=sharing",
      },
      {
        id: "elyxir",
        type: "wide",
        alt: "Elyxir SaaS Promo Video",
        isVideo: false,
        count: 1,
        format: "png",
        title: "Elyxir / SaaS Promo Video",
        url: "https://drive.google.com/file/d/1XmOSaiInx372oq_wP6j5wbqhQrFqWnTZ/view?usp=drive_link",
      },
      {
        id: "lakai",
        type: "tall",
        alt: "LakAI SaaS Feature Video",
        isVideo: false,
        count: 1,
        format: "png",
        title: "LakAI / SaaS Feature Video",
        url: "https://drive.google.com/file/d/1jTUWP8F5jklYSAsdmcHIzfurzl3WbCkD/view?usp=drive_link",
      },
    ],
  },
  {
    class: "projects-bottom",
    projects: [
      {
        id: "arena",
        type: "tall",
        alt: "Arena Project Luxury Logistics",
        count: 4,
        title: "Arena Project / Creative Engineering",
        url: "project.html?project=arena",
        format: "png",
      },
      {
        id: "007",
        type: "wide",
        alt: "Osp curated sneakers",
        count: 8,
        title: "OSP / Curated sneakers",
        url: "#",
        format: "avif",
      },
    ],
  },
];

class ProjectsGrid extends SectionComponent {
  constructor(element) {
    super(element);
    this._generateHTML();
    this._initElements();
    this._setupOptions();
    this.animationFinished = false;
    this._bindMouseEvents();
  }

  _generateHTML() {
    const t = {
      "projects-top": document.querySelector(".projects-top"),
      "projects-middle": document.querySelector(".projects-middle"),
      "projects-bottom": document.querySelector(".projects-bottom"),
    };

    tt.forEach((i) => {
      const s = t[i.class];
      if (!s) return;
      s.innerHTML = "";
      const isTop = i.class === "projects-top";
      i.projects.forEach((n) => {
        const r = this._createImageStack(n, isTop);
        const a = this._createContent(n);

        const link = document.createElement("a");
        link.href = n.url;
        if (n.url.startsWith("http")) {
          link.target = "_blank";
          link.rel = "noopener noreferrer";
        }
        link.style.display = "block";

        const l = document.createElement("div");
        l.appendChild(r);
        l.appendChild(a);

        link.appendChild(l);
        s.appendChild(link);
      });
    });
  }

  _createImageStack(t, isTop) {
    const s = document.createElement("div");
    s.classList.add("image-stack", `image-stack__${t.type}`);
    if (isTop) {
      s.classList.add("image-animate");
    }
    if (t.isVideo) {
      const v = document.createElement("video");
      v.classList.add(t.type, "images", "active");
      v.src = `images/works/${t.id}/video.mp4`;
      v.muted = true;
      v.loop = true;
      v.playsInline = true;
      v.preload = "auto";
      v.style.objectFit = "cover";
      v.style.width = "100%";
      v.style.height = "100%";
      v.style.opacity = isTop ? "0" : "1";
      s.appendChild(v);
    } else {
      const isDesktop = window.innerWidth >= 650;
      const size = isDesktop ? "large" : "small";
      for (let n = 0; n < t.count; n++) {
        const r = new Image();
        r.classList.add(t.type, "images");
        const ext = t.format || "jpg";
        r.src = `images/works/${t.id}/${size}/${n + 1}.${ext}?v=3`;
        r.alt = t.alt;
        r.loading = "lazy";
        if (n === 0 && !isTop) {
          r.classList.add("active");
        }
        s.appendChild(r);
      }
    }
    return s;
  }

  _createContent(t) {
    const i = document.createElement("div");
    i.classList.add("projects-content", "projects-text");
    const s = document.createElement("span");
    const o = document.createElement("span");
    s.textContent = `(${t.id})`;
    o.textContent = t.title;
    i.appendChild(s);
    i.appendChild(o);
    return i;
  }

  _initElements() {
    this.projectsDiv = document.querySelectorAll(".image-animate");
    this.imageStack = document.querySelectorAll(".image-stack");
    this.projectsText = document.querySelectorAll(".projects-text");
  }

  _setupOptions() {
    this.projectsOptions = {
      duration: 650,
      fill: "forwards",
      easing: M,
    };
  }

  _animateDivs() {
    this.projectsDiv.forEach((t, i) => {
      setTimeout(() => {
        t.style.opacity = 1;
        t.animate(E, this.projectsOptions);
      }, i * 150);
    });
  }

  async _animateImages() {
    const t = [
      { transform: "translateY(100%) scale(1.3)" },
      { transform: "translateY(30%) scale(1.2)" },
      { transform: "translateY(10%) scale(1.1)" },
      { transform: "translateY(0) scale(1)" },
    ];
    const i = [];
    this.projectsText.forEach((s) => {
      s.style.opacity = 1;
      s.style.transition = "opacity 600ms 400ms";
    });
    this.projectsDiv.forEach((s, o) => {
      const n = s.querySelector(".images");
      if (n) {
        setTimeout(() => {
          n.style.opacity = 1;
          const r = n.animate(t, this.projectsOptions);
          r.onfinish = () => {
            n.classList.add("active");
            n.style.opacity = "";
          };
          i.push(r.finished);
        }, o * 150);
      }
    });
    await Promise.all(i);
    this.animationFinished = true;
  }

  _bindMouseEvents() {
    const isDesktop = window.innerWidth >= 650;
    this.imageStack.forEach((t) => {
      const v = t.querySelector("video");
      if (v) {
        const playVideo = () => {
          v.play().catch((e) => {});
        };
        const pauseVideo = () => {
          v.pause();
          v.currentTime = 0;
        };
        if (isDesktop) {
          t.addEventListener("mouseenter", playVideo);
          t.addEventListener("mouseleave", pauseVideo);
        } else {
          t.addEventListener("touchstart", playVideo);
          t.addEventListener("touchend", pauseVideo);
        }
        return;
      }

      const i = t.querySelectorAll(".images");
      if (i.length === 0) return;
      let s = 0,
        o = null,
        n = 0;
      const r = 200;
      const a = (h) => {
        if (!n) n = h;
        if (h - n >= r) {
          i[s].classList.remove("active");
          s = (s + 1) % i.length;
          i[s].classList.add("active");
          n = h;
        }
        o = requestAnimationFrame(a);
      };
      const l = () => {
        if (!o) {
          n = 0;
          o = requestAnimationFrame(a);
        }
      };
      const d = () => {
        if (o) {
          cancelAnimationFrame(o);
          o = null;
        }
      };
      if (isDesktop) {
        t.addEventListener("mouseenter", l);
        t.addEventListener("mouseleave", d);
      } else {
        t.addEventListener("contextmenu", (h) => h.preventDefault());
        t.addEventListener("touchstart", l);
        t.addEventListener("touchend", d);
      }
    });
  }

  onEnter() {
    this._animateDivs();
    setTimeout(() => this._animateImages(), 600);
  }
}

// ── VIDEO GALLERY LIGHTBOX ──────────────────────────────────────────────
function initVideoGallery() {
  const filterBtns = document.querySelectorAll(".filter-btn");
  const cards = document.querySelectorAll(".video-card-wrapper");
  const modal = document.getElementById("lightboxModal");
  const videoContainer = document.getElementById("lightboxVideoContainer");
  const modalClose = document.getElementById("lightboxClose");
  const modalOverlay = document.getElementById("lightboxOverlay");
  const modalTitle = document.getElementById("lightboxTitle");
  const btnPrev = document.getElementById("lightboxPrev");
  const btnNext = document.getElementById("lightboxNext");

  if (!cards.length || !modal || !videoContainer) return;

  let activeIndex = 0;
  let visibleCards = Array.from(cards);

  // 1. FILTER FUNCTIONALITY
  filterBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      filterBtns.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");

      const filterValue = btn.getAttribute("data-filter");
      visibleCards = [];

      cards.forEach((card) => {
        const category = card.getAttribute("data-category");
        if (filterValue === "all" || category === filterValue) {
          card.style.display = "block";
          visibleCards.push(card);
        } else {
          card.style.display = "none";
        }
      });

      // Update data-index dynamically on filtered list for navigation purposes
      visibleCards.forEach((card, idx) => {
        card.setAttribute("data-filtered-index", idx);
      });
    });
  });

  // Initialize filtered index on boot
  cards.forEach((card, idx) => {
    card.setAttribute("data-filtered-index", idx);
  });

  // 2. LIGHTBOX LAUNCH
  const openVideo = (card) => {
    const vimeoId = card.getAttribute("data-vimeo-id");
    const title = card.getAttribute("data-title");
    activeIndex = parseInt(card.getAttribute("data-filtered-index"), 10);

    if (vimeoId) {
      videoContainer.innerHTML = `<iframe src="https://player.vimeo.com/video/${vimeoId}?autoplay=1&badge=0&autopause=0&player_id=0&app_id=58479" frameborder="0" allow="autoplay; fullscreen; picture-in-picture; clipboard-write; encrypted-media; web-share" referrerpolicy="strict-origin-when-cross-origin" style="position:absolute;top:0;left:0;width:100%;height:100%;" title="${title}"></iframe>`;
      if (modalTitle) modalTitle.textContent = title;
      modal.classList.add("active");

      // Pause Lenis smooth scroll
      if (window.__lenis) {
        window.__lenis.stop();
      }
    }
  };

  // Bind click on each card to open in lightbox
  cards.forEach((card) => {
    card.addEventListener("click", () => openVideo(card));
  });

  const closeModal = () => {
    modal.classList.remove("active");
    videoContainer.innerHTML = ""; // Stop video playback

    // Resume Lenis smooth scroll
    if (window.__lenis) {
      window.__lenis.start();
    }
  };

  if (modalClose) modalClose.addEventListener("click", closeModal);
  if (modalOverlay) modalOverlay.addEventListener("click", closeModal);

  // 3. NAVIGATION (PREV/NEXT)
  const navigate = (direction) => {
    if (!visibleCards.length) return;
    if (direction === "next") {
      activeIndex = (activeIndex + 1) % visibleCards.length;
    } else {
      activeIndex = (activeIndex - 1 + visibleCards.length) % visibleCards.length;
    }
    const nextCard = visibleCards[activeIndex];
    openVideo(nextCard);
  };

  if (btnPrev) btnPrev.addEventListener("click", () => navigate("prev"));
  if (btnNext) btnNext.addEventListener("click", () => navigate("next"));

  // Bind Escape and arrow keys globally, cleaning up the old listener if it exists
  if (window.__videoGalleryKeydownHandler) {
    document.removeEventListener("keydown", window.__videoGalleryKeydownHandler);
  }

  window.__videoGalleryKeydownHandler = (e) => {
    const activeModal = document.getElementById("lightboxModal");
    if (!activeModal || !activeModal.classList.contains("active")) return;
    if (e.key === "Escape") {
      closeModal();
    } else if (e.key === "ArrowRight") {
      navigate("next");
    } else if (e.key === "ArrowLeft") {
      navigate("prev");
    }
  };

  document.addEventListener("keydown", window.__videoGalleryKeydownHandler);
}

// ── OBSERVE AND PLAY/PAUSE NATIVE PREVIEW VIDEOS ────────────────────────
function initPreviewVideosObserver() {
  const videos = document.querySelectorAll(".card-preview-video");
  if (!videos.length) return;

  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      const video = entry.target;
      if (entry.isIntersecting) {
        // Play video when visible
        video.play().catch((err) => {
          console.warn("Preview video play failed/blocked:", err);
        });
      } else {
        // Pause video when out of viewport
        video.pause();
      }
    });
  }, { threshold: 0.05 });

  videos.forEach((video) => observer.observe(video));
}


// ── CONTACT FORM TO WHATSAPP ────────────────────────────────────────────
function initContactForm() {
  const whatsappForm = document.getElementById("whatsappForm");
  if (!whatsappForm) return;

  whatsappForm.addEventListener("submit", (e) => {
    e.preventDefault();

    const name = document.getElementById("form-name").value.trim();
    const phone = document.getElementById("form-phone").value.trim();
    const email = document.getElementById("form-email").value.trim();
    const budget = document.getElementById("form-budget").value;
    const brief = document.getElementById("form-brief").value.trim();

    const whatsappNumber = "916289059806";
    const message = `Hi Ryuk Design Studio,

I want to query about a project:

• Name: ${name}
• Phone: ${phone}
• Email: ${email}
• Budget: ${budget}
• Brief: ${brief}`;

    const encodedMessage = encodeURIComponent(message);
    const whatsappUrl = `https://wa.me/${whatsappNumber}?text=${encodedMessage}`;

    window.open(whatsappUrl, "_blank");
  });
}

// ── FOOTER DYNAMIC CLOCK ────────────────────────────────────────────────
function initFooterClock() {
  const clockEl = document.getElementById("footerClock");
  if (!clockEl) return;

  function updateClock() {
    const options = {
      timeZone: "Asia/Kolkata",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    };
    try {
      const formatter = new Intl.DateTimeFormat("en-US", options);
      const timeStr = formatter.format(new Date());
      clockEl.textContent = `IST → ${timeStr}`;
    } catch (e) {
      const now = new Date();
      const hh = String(now.getHours()).padStart(2, "0");
      const mm = String(now.getMinutes()).padStart(2, "0");
      clockEl.textContent = `IST → ${hh}:${mm}`;
    }
  }

  updateClock();
  if (window.__footerClockInterval) {
    clearInterval(window.__footerClockInterval);
  }
  window.__footerClockInterval = setInterval(updateClock, 1000);
}

// ── FOOTER FAQ ACCORDION ────────────────────────────────────────────────
function initFooterFAQ() {
  const items = document.querySelectorAll(".footer-faq-item");
  if (!items.length) return;

  items.forEach((item) => {
    const btn = item.querySelector(".footer-faq-question");
    if (!btn) return;

    btn.addEventListener("click", () => {
      const isOpen = item.classList.contains("is-open");

      // Close all items first
      items.forEach((other) => {
        other.classList.remove("is-open");
        const otherBtn = other.querySelector(".footer-faq-question");
        if (otherBtn) otherBtn.setAttribute("aria-expanded", "false");
      });

      // If it was closed, open it
      if (!isOpen) {
        item.classList.add("is-open");
        btn.setAttribute("aria-expanded", "true");
      }
    });
  });
}

// ── MAIN CONTROLLER ─────────────────────────────────────────────────────
const AppController = {
  afterLoad(isProjectPage) {
    // Init smooth scroll
    const smooth = new Smooth();
    const lenis = smooth.init();
    window.__lenis = lenis;

    // Init GSAP
    const anim = new Animations();
    anim.init();
    window.__animationsInstance = anim;

    // Init Hover Reveal
    initHoverReveal();

    // Init Hero 3D Parallax
    initHero3DParallax();

    // Porto-style microinteractions
    initMagnetic();
    initScrollRevealLines();
    initWorkRowTilt();
    initButtonFill();

    // Anchors
    initAnchors(lenis);

    // Nav
    new Nav();

    // Page transitions
    new PageTransition(!isProjectPage);
    // Initialize works components
    if (!isProjectPage) {
      // Initialize video gallery
      initVideoGallery();
      initPreviewVideosObserver();

      // Initialize contact form
      initContactForm();

      // Initialize footer clock
      initFooterClock();

      // Initialize footer FAQ accordion
      initFooterFAQ();

      // Initialize liquid gradient shader
      let shaderCanvas = document.getElementById("shaderCanvas");

      // Clean up previous WebGL shader instance and animation loop to prevent context leaks
      if (window.__shaderAnimationFrameId) {
        cancelAnimationFrame(window.__shaderAnimationFrameId);
        window.__shaderAnimationFrameId = null;
      }
      if (window.__liquidShaderInstance) {
        try {
          const gl = window.__liquidShaderInstance.gl;
          if (gl) {
            const ext = gl.getExtension("WEBGL_lose_context");
            if (ext) ext.loseContext();
          }
        } catch (e) {
          console.warn("WebGL cleanup error:", e);
        }
        window.__liquidShaderInstance = null;
      }

      if (shaderCanvas) {
        shaderCanvas.style.display = "";
        // Recreate canvas to completely bypass browser context reuse limits after loseContext()
        const newCanvas = shaderCanvas.cloneNode(true);
        shaderCanvas.parentNode.replaceChild(newCanvas, shaderCanvas);
        shaderCanvas = newCanvas;

        const liquidShader = new LiquidShader(shaderCanvas);
        window.__liquidShaderInstance = liquidShader;

        const animateShader = (time) => {
          if (window.__liquidShaderInstance !== liquidShader) {
            return;
          }
          liquidShader.render(time);
          window.__shaderAnimationFrameId = requestAnimationFrame(animateShader);
        };

        // IntersectionObserver to pause rendering when hero is out of view
        const heroEl = document.getElementById("hero");
        if (heroEl) {
          const observer = new IntersectionObserver((entries) => {
            const [entry] = entries;
            if (entry.isIntersecting) {
              // Resume loop if not running
              if (!window.__shaderAnimationFrameId && window.__liquidShaderInstance === liquidShader) {
                window.__shaderAnimationFrameId = requestAnimationFrame(animateShader);
              }
            } else {
              // Pause loop
              if (window.__shaderAnimationFrameId) {
                cancelAnimationFrame(window.__shaderAnimationFrameId);
                window.__shaderAnimationFrameId = null;
              }
            }
          }, { threshold: 0.02 });
          observer.observe(heroEl);
        } else {
          window.__shaderAnimationFrameId = requestAnimationFrame(animateShader);
        }
      }

      const worksEl = document.getElementById("works");
      const projectsTopEl = document.querySelector(".projects-top");
      const projectsMiddleEl = document.querySelector(".projects-middle");
      const projectsBottomEl = document.querySelector(".projects-bottom");
      if (worksEl) worksEl.style.display = "grid";
      if (projectsTopEl) projectsTopEl.style.display = "grid";
      if (projectsMiddleEl) projectsMiddleEl.style.display = "grid";
      if (projectsBottomEl) projectsBottomEl.style.display = "grid";

      if (worksEl) {
        new WorksSlab(worksEl);
      }
      if (projectsTopEl) {
        new ProjectsGrid(projectsTopEl);
      }
    }
  },
};

// ── BOOT ─────────────────────────────────────────────────────────────────
window.addEventListener("DOMContentLoaded", () => {
  // Chroma-key cutout
  generateModelCutout();

  // Cursor (always on)
  new Cursor();

  const isProjectPage =
    window.location.pathname.includes("project") ||
    window.location.search.includes("project=") ||
    window.location.pathname.includes("nestora") ||
    window.location.pathname.includes("theroom");

  if (isProjectPage) {
    // On project page: skip preloader, init directly
    document.body.classList.remove("is-loading");
    const preEl = document.getElementById("loadingWrapper");
    if (preEl) preEl.style.display = "none";
    AppController.afterLoad(true);

    // Play the reveal animation immediately (since there's no preloader)
    if (window.__animationsInstance) {
      window.__animationsInstance.triggerSiteReveal();
    }

    // FAQ Accordion toggles
    document.querySelectorAll(".faq-item").forEach((item) => {
      item.addEventListener("click", () => {
        const isActive = item.classList.contains("active");
        document.querySelectorAll(".faq-item").forEach((other) => {
          other.classList.remove("active");
        });
        if (!isActive) {
          item.classList.add("active");
        }
      });
    });

    // Run project-specific animations
    setTimeout(() => {
      if (typeof initProjectAnimations === "function") {
        initProjectAnimations();
      }
    }, 100);
  } else {
    // Index: run preloader flow
    new PreloaderController();
  }
});
