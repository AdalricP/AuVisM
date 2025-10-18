// Audio Functions //

async function getAudioDeviceByName(deviceName) {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const audioDevice = devices.find(
    (device) =>
      device.kind === "audioinput" && device.label.includes(deviceName)
  );
  if (audioDevice) {
    return audioDevice.deviceId;
  } else {
    console.warn(`Audio device '${deviceName}' not found, using default device`);
    // Return undefined to use default device
    return undefined;
  }
}

let animFrame;
let visualizerContainer;
let visualizerElement;
let frequencyBars = [];
let previousValues = [];
let currentValues = [];
let previousFft = [];
let previousDisplay = [];
let audioContext = null;
let analyser = null;
let dataArray = null;
let bufferLength = 0;
let isAudioRunning = false;
let sampleRate = 44100;

// WebGL state
let gl = null;
let glCanvas = null;
let glProgram = null;
let glWaveProgram = null; // waveform program
let glNdcProgram = null;  // direct NDC program for precomputed positions
let attribs = {};
let uniforms = {};
let quadVbo = null;
let instXVbo = null;
let instWidthVbo = null;
let instHeightVbo = null;
let instanceCount = 0;
let paddingPx = 10;

// Waveform buffers/state
let waveVbo = null;             // XY pairs for line strip
let waveResolution = 1024;      // number of samples to render
let waveformThickness = 1.5;    // line thickness multiplier (base DPR scaling)

// Live render color (updated by IPC)
let renderColor = "rgba(255, 255, 255, 0.8)";

// Drag and resize functionality
let isDragging = false;
let isResizing = false;
let isRotating = false;
let dragStart = { x: 0, y: 0 };
let resizeStart = { x: 0, y: 0, width: 0, height: 0 };
let rotationStart = { x: 0, y: 0, angle: 0 };
let currentRotation = 0;

// Noise animation state
let noiseSeed = Math.random() * 1000;

// Optional minimum bar height (percentage, 0-100)
let minBarHeight = 0;

// Visualization settings
let visualMode = 'linear'; // 'linear', 'circle-perimeter', 'circle-waveform'
let smoothInterpolation = false;
let smoothTransitions = false;
let transitionWeight = 0.3;

// Audio processing settings
let frequencyRange = { start: 0, end: 1 }; // Normalized frequency range (0-1)
let frequencySmoothing = 0.8; // How much to smooth frequency data
let useLogFrequencyScale = true;   // Map bars to log-spaced frequency bands
let useDecibelScale = true;        // Convert magnitudes to dB scale
let minFrequencyHz = 20;           // Skip DC/very low frequencies
let maxFrequencyHz = null;         // Default to Nyquist if null
let dbFloor = -70;                 // dB floor for normalization
// Optional tilt to compensate natural spectral roll-off (approx pink-like)
// Positive values lift highs; expressed in dB per octave relative to tiltRefHz
let tiltDbPerOctave = 4.0;
let tiltRefHz = 1000;
// Aggregation mode: energy (sum of squares) vs mean magnitude
let aggregateWithEnergy = true;
// Compensate for wider low-frequency bands by normalizing energy by bin count
let compensateBandwidth = true;

async function initializeAudio(deviceName, fft_size) {
  try {
    if (audioContext) {
      audioContext.close();
    }

    audioContext = new (window.AudioContext || window.webkitAudioContext)();
  sampleRate = audioContext.sampleRate || 44100;
    const deviceId = await getAudioDeviceByName(deviceName);
    const constraints = deviceId 
      ? { audio: { deviceId: { exact: deviceId } } }
      : { audio: true }; // fallback to default device
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    const source = audioContext.createMediaStreamSource(stream);
    analyser = audioContext.createAnalyser();
    source.connect(analyser);

    analyser.fftSize = fft_size;
  // Reduce built-in temporal smoothing; we do our own per-bin smoothing
  analyser.smoothingTimeConstant = 0.05;
    bufferLength = analyser.frequencyBinCount;
    dataArray = new Uint8Array(bufferLength);

    // Initialize arrays
    if (previousValues.length !== bufferLength) {
      previousValues = new Array(bufferLength).fill(0);
      currentValues = new Array(bufferLength).fill(0);
    }
    if (previousFft.length !== bufferLength) {
      previousFft = new Array(bufferLength).fill(0);
    }

    isAudioRunning = true;
    return true;
  } catch (error) {
    const errorMsg = `Error capturing system audio: ${error.message}`;
    console.error(errorMsg);
    alert(errorMsg); // DEBUG: show error as alert
    const errorDisplay = document.createElement("div");
    errorDisplay.style.color = "red";
    errorDisplay.style.fontSize = "20px";
    errorDisplay.style.padding = "20px";
    errorDisplay.innerText = errorMsg;
    document.body.appendChild(errorDisplay);
    return false;
  }
}

function startRendering(noise_intensity) {
  if (animFrame) { 
    cancelAnimationFrame(animFrame);
  }

  // Ensure WebGL initialized
  if (!gl) {
    initWebGL();
  }

  function renderFrame() {
    if (!isAudioRunning || !analyser || !dataArray) {
      animFrame = requestAnimationFrame(renderFrame);
      return;
    }

    animFrame = requestAnimationFrame(renderFrame);
    analyser.getByteFrequencyData(dataArray);

    // Process frequency data with proper distribution
  const processedData = processFrequencyData(dataArray, bufferLength);
    
    // Apply smooth transitions if enabled
    if (smoothTransitions) {
      if (previousDisplay.length !== processedData.length) {
        previousDisplay = new Array(processedData.length).fill(0);
      }
      for (let i = 0; i < processedData.length; i++) {
        const v = previousDisplay[i] * (1 - transitionWeight) + processedData[i] * transitionWeight;
        processedData[i] = v;
        previousDisplay[i] = v;
      }
    }

    // Apply smooth interpolation if enabled
    let finalValues = processedData;
    if (smoothInterpolation) {
      finalValues = interpolateValues(processedData);
    }

    // Apply optional animated noise overlay (visual jitter)
    if (noise_intensity && noise_intensity > 0) {
      const t = performance.now() * 0.001;
      const amp = Math.max(0, noise_intensity) * 0.125; // scale noise intensity
      for (let i = 0; i < finalValues.length; i++) {
        // Smooth pseudo-noise: two sines with different spatial/temporal frequencies
        const n1 = Math.sin((i * 0.18) + (t * 1.3) + noiseSeed);
        const n2 = Math.sin((i * 0.41) - (t * 0.7) + noiseSeed * 1.7);
        const n = (n1 + 0.5 * n2) * 0.666; // roughly in [-1,1]
        const delta = n * amp;
        finalValues[i] = Math.min(100, Math.max(0, finalValues[i] + delta));
      }
    }

    // Update visualization based on mode
    if (visualMode === 'linear') {
      renderLinearWebGL(finalValues, renderColor);
    } else if (visualMode === 'linear-smooth') {
      // Interpolate for extra smoothness
      let smoothVals = interpolateValues(processedData);
      smoothVals = interpolateValues(smoothVals);
      renderSmoothLineWebGL(smoothVals, renderColor);
    } else if (visualMode === 'linear-waveform') {
      const td = new Uint8Array(bufferLength * 2);
      analyser.getByteTimeDomainData(td);
      renderWaveformWebGL(renderColor, td);
    } else if (visualMode === 'circle-perimeter') {
      renderCirclePerimeterWebGL(finalValues, renderColor);
    } else if (visualMode === 'circle-waveform') {
      const td = new Uint8Array(bufferLength * 2);
      analyser.getByteTimeDomainData(td);
      renderCircleWaveformWebGL(renderColor, td);
    }
// Render a smooth line (polyline) through the values for 'linear-smooth' mode
function renderSmoothLineWebGL(values, color) {
  if (!gl || !glWaveProgram) return;
  resizeGlCanvas();
  const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  const widthPx = glCanvas.width;
  const heightPx = glCanvas.height;

  gl.viewport(0, 0, widthPx, heightPx);
  gl.clearColor(0,0,0,0);
  gl.clear(gl.COLOR_BUFFER_BIT);

  // Prepare points for line strip (not inverted)
  const N = values.length;
  const verts = new Float32Array(N * 2);
  for (let i = 0; i < N; i++) {
    const x = i / (N - 1);
    // y = 0 at bottom, y = 1 at top
    const y = Math.max(minBarHeight / 100, values[i] / 100);
    verts[i * 2 + 0] = x;
    verts[i * 2 + 1] = y;
  }

  // Optionally fill area below the curve
  if (typeof window.fillSmoothLine === 'undefined') window.fillSmoothLine = false;
  if (window.fillSmoothLine) {
    // Vertices: bottom left (x of first point, y=0), all curve points, bottom right (x of last point, y=0)
    const fillVerts = new Float32Array((N + 2) * 2);
    fillVerts[0] = verts[0]; fillVerts[1] = 0; // bottom left (x of first point, y=0)
    for (let i = 0; i < N; i++) {
      fillVerts[(i + 1) * 2 + 0] = verts[i * 2 + 0];
      fillVerts[(i + 1) * 2 + 1] = verts[i * 2 + 1];
    }
    fillVerts[(N + 1) * 2 + 0] = verts[(N - 1) * 2 + 0]; fillVerts[(N + 1) * 2 + 1] = 0; // bottom right (x of last point, y=0)

    gl.useProgram(glWaveProgram);
    gl.bindBuffer(gl.ARRAY_BUFFER, waveVbo);
    gl.bufferData(gl.ARRAY_BUFFER, fillVerts, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    const u_res = gl.getUniformLocation(glWaveProgram, 'u_resolution');
    const u_pad = gl.getUniformLocation(glWaveProgram, 'u_padding');
    const u_col = gl.getUniformLocation(glWaveProgram, 'u_color');
    gl.uniform2f(u_res, widthPx, heightPx);
    gl.uniform1f(u_pad, paddingPx * dpr);
    // Use a faded color for fill
    const col = hexOrRgbaToVec4(color);
    gl.uniform4f(u_col, col[0], col[1], col[2], 0.25 * col[3]);
    gl.drawArrays(gl.TRIANGLE_FAN, 0, N + 2);
  }

  // Draw the smooth line on top
  gl.useProgram(glWaveProgram);
  gl.bindBuffer(gl.ARRAY_BUFFER, waveVbo);
  gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  const u_res = gl.getUniformLocation(glWaveProgram, 'u_resolution');
  const u_pad = gl.getUniformLocation(glWaveProgram, 'u_padding');
  const u_col = gl.getUniformLocation(glWaveProgram, 'u_color');
  gl.uniform2f(u_res, widthPx, heightPx);
  gl.uniform1f(u_pad, paddingPx * dpr);
  const col = hexOrRgbaToVec4(color);
  gl.uniform4f(u_col, col[0], col[1], col[2], col[3]);

  if (gl.LINE_SMOOTH) gl.enable(gl.LINE_SMOOTH);
  gl.lineWidth(Math.max(1, Math.min(6, 2 * dpr)));
  gl.drawArrays(gl.LINE_STRIP, 0, N);
}
  }

  renderFrame();
}

function resizeGlCanvas() {
  if (!gl || !glCanvas) return;
  const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  const rect = glCanvas.getBoundingClientRect();
  const width = Math.max(1, Math.floor(rect.width * dpr));
  const height = Math.max(1, Math.floor(rect.height * dpr));
  if (glCanvas.width !== width || glCanvas.height !== height) {
    glCanvas.width = width;
    glCanvas.height = height;
    gl.viewport(0, 0, width, height);
  }
}

function initWebGL() {
  gl = glCanvas.getContext('webgl2', { antialias: true, alpha: true, premultipliedAlpha: false });
  if (!gl) {
    gl = glCanvas.getContext('webgl', { antialias: true, alpha: true, premultipliedAlpha: false });
  }
  if (!gl) {
    console.error('WebGL not supported');
    alert('WebGL not supported!'); // DEBUG
    return;
  }

  resizeGlCanvas();

  const vs = `#version 300 es\n
  layout(location=0) in vec2 a_pos; // quad
  layout(location=1) in float i_x;   // instance x position (0..1)
  layout(location=2) in float i_w;   // instance width (0..1)
  layout(location=3) in float i_h;   // instance height (0..1)
  uniform vec2 u_resolution;         // canvas size in px
  uniform float u_padding;           // padding in px
  uniform float u_numBars;           // number of bars
  
  void main() {
    // Convert instance to pixel space (centered bars)
    float centerX = mix(u_padding, u_resolution.x - u_padding, i_x);
    float barW = i_w * (u_resolution.x - 2.0 * u_padding);
    float barH = i_h * (u_resolution.y - 2.0 * u_padding);
    // a_pos is in [0,1]x[0,1] for quad corners (left-bottom to right-top)
    // Convert to left-bottom anchored quad using centerX
    float leftX = centerX - 0.5 * barW;
    vec2 posPx = vec2(leftX + a_pos.x * barW, u_resolution.y - u_padding - a_pos.y * barH);
    // to NDC
    vec2 ndc = (posPx / u_resolution) * 2.0 - 1.0;
    ndc.y = -ndc.y;
    gl_Position = vec4(ndc, 0.0, 1.0);
  }`;

  const fs = `#version 300 es\n
  precision mediump float;
  uniform vec4 u_color;
  out vec4 outColor;
  void main(){ outColor = u_color; }`;

  function compile(type, src){
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.error('Shader error', gl.getShaderInfoLog(s));
    }
    return s;
  }
  const vsh = compile(gl.VERTEX_SHADER, vs);
  const fsh = compile(gl.FRAGMENT_SHADER, fs);
  glProgram = gl.createProgram();
  gl.attachShader(glProgram, vsh);
  gl.attachShader(glProgram, fsh);
  gl.linkProgram(glProgram);
  if (!gl.getProgramParameter(glProgram, gl.LINK_STATUS)) {
    console.error('Program link error', gl.getProgramInfoLog(glProgram));
  }
  gl.useProgram(glProgram);

  // Quad (two triangles) in [0,1]x[0,1]
  const quad = new Float32Array([
    0,0,  1,0,  0,1,
    1,0,  1,1,  0,1,
  ]);
  quadVbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quadVbo);
  gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  // Instance buffers (x, width, height)
  instXVbo = gl.createBuffer();
  instWidthVbo = gl.createBuffer();
  instHeightVbo = gl.createBuffer();

  // Attribute 1: i_x
  gl.bindBuffer(gl.ARRAY_BUFFER, instXVbo);
  gl.enableVertexAttribArray(1);
  gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 0, 0);
  gl.vertexAttribDivisor(1, 1);
  // Attribute 2: i_w
  gl.bindBuffer(gl.ARRAY_BUFFER, instWidthVbo);
  gl.enableVertexAttribArray(2);
  gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 0, 0);
  gl.vertexAttribDivisor(2, 1);
  // Attribute 3: i_h
  gl.bindBuffer(gl.ARRAY_BUFFER, instHeightVbo);
  gl.enableVertexAttribArray(3);
  gl.vertexAttribPointer(3, 1, gl.FLOAT, false, 0, 0);
  gl.vertexAttribDivisor(3, 1);

  uniforms.u_resolution = gl.getUniformLocation(glProgram, 'u_resolution');
  uniforms.u_color = gl.getUniformLocation(glProgram, 'u_color');
  uniforms.u_padding = gl.getUniformLocation(glProgram, 'u_padding');
  uniforms.u_numBars = gl.getUniformLocation(glProgram, 'u_numBars');

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

  // Waveform shader program (line strip)
  const vsWave = `#version 300 es\n
  layout(location=0) in vec2 a_xy;  // normalized 0..1 x and -1..1 y
  uniform vec2 u_resolution;         // canvas size in px
  uniform float u_padding;           // padding in px
  void main(){
    float xPx = mix(u_padding, u_resolution.x - u_padding, a_xy.x);
    float yMid = u_resolution.y * 0.5;
    float yRange = (u_resolution.y - 2.0 * u_padding) * 0.5;
    float yPx = yMid - (a_xy.y * yRange);
    vec2 ndc = (vec2(xPx, yPx) / u_resolution) * 2.0 - 1.0;
    ndc.y = -ndc.y;
    gl_Position = vec4(ndc, 0.0, 1.0);
  }`;

  const fsWave = `#version 300 es\n
  precision mediump float;
  uniform vec4 u_color;
  out vec4 outColor;
  void main(){ outColor = u_color; }`;

  const vshW = compile(gl.VERTEX_SHADER, vsWave);
  const fshW = compile(gl.FRAGMENT_SHADER, fsWave);
  glWaveProgram = gl.createProgram();
  gl.attachShader(glWaveProgram, vshW);
  gl.attachShader(glWaveProgram, fshW);
  gl.linkProgram(glWaveProgram);
  if (!gl.getProgramParameter(glWaveProgram, gl.LINK_STATUS)) {
    console.error('Wave program link error', gl.getProgramInfoLog(glWaveProgram));
  }

  waveVbo = gl.createBuffer();

  // Simple NDC shader (positions provided already in NDC space)
  const vsNdc = `#version 300 es\n
  layout(location=0) in vec2 a_ndc;\n
  void main(){\n
    gl_Position = vec4(a_ndc, 0.0, 1.0);\n
  }`;
  const fsNdc = `#version 300 es\n
  precision mediump float;\n
  uniform vec4 u_color;\n
  out vec4 outColor;\n
  void main(){ outColor = u_color; }`;
  const vshN = compile(gl.VERTEX_SHADER, vsNdc);
  const fshN = compile(gl.FRAGMENT_SHADER, fsNdc);
  glNdcProgram = gl.createProgram();
  gl.attachShader(glNdcProgram, vshN);
  gl.attachShader(glNdcProgram, fshN);
  gl.linkProgram(glNdcProgram);
  if (!gl.getProgramParameter(glNdcProgram, gl.LINK_STATUS)) {
    console.error('NDC program link error', gl.getProgramInfoLog(glNdcProgram));
  }
}

function hexOrRgbaToVec4(color){
  // Expect rgba(r,g,b,a) or #rrggbb
  if (color.startsWith('rgba')) {
    const m = color.match(/rgba\((\d+)\,\s*(\d+)\,\s*(\d+)\,\s*([0-9\.]+)\)/);
    if (m) return [parseInt(m[1])/255, parseInt(m[2])/255, parseInt(m[3])/255, parseFloat(m[4])];
  }
  if (color.startsWith('#')) {
    const r = parseInt(color.slice(1,3),16)/255;
    const g = parseInt(color.slice(3,5),16)/255;
    const b = parseInt(color.slice(5,7),16)/255;
    return [r,g,b,1];
  }
  return [1,1,1,0.8];
}

function renderLinearWebGL(values, color){
  if (!gl) return;
  resizeGlCanvas();
  const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  const widthPx = glCanvas.width;
  const heightPx = glCanvas.height;

  gl.viewport(0, 0, widthPx, heightPx);
  gl.clearColor(0,0,0,0);
  gl.clear(gl.COLOR_BUFFER_BIT);

  const numBars = Math.min(values.length, 512);
  if (instanceCount !== numBars) {
    instanceCount = numBars;
  }

  // Build instance arrays in normalized space
  const xs = new Float32Array(numBars);
  const ws = new Float32Array(numBars);
  const hs = new Float32Array(numBars);
  for (let i=0;i<numBars;i++){
    xs[i] = (i + 0.5)/numBars; // centers across 0..1
    ws[i] = 1.0/numBars;       // uniform width
    const h = values[i]/100;
    hs[i] = Math.min(1.0, Math.max(minBarHeight/100, h));
  }

  // Ensure quad attribute bound for bars
  gl.bindBuffer(gl.ARRAY_BUFFER, quadVbo);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  gl.bindBuffer(gl.ARRAY_BUFFER, instXVbo);
  gl.bufferData(gl.ARRAY_BUFFER, xs, gl.DYNAMIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, instWidthVbo);
  gl.bufferData(gl.ARRAY_BUFFER, ws, gl.DYNAMIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, instHeightVbo);
  gl.bufferData(gl.ARRAY_BUFFER, hs, gl.DYNAMIC_DRAW);

  const col = hexOrRgbaToVec4(color);
  gl.useProgram(glProgram);
  gl.uniform2f(uniforms.u_resolution, widthPx, heightPx);
  gl.uniform1f(uniforms.u_padding, paddingPx * dpr);
  gl.uniform4f(uniforms.u_color, col[0], col[1], col[2], col[3]);
  gl.uniform1f(uniforms.u_numBars, numBars);

  // Draw instanced quads (two triangles => 6 verts per instance)
  gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, instanceCount);
}

function renderWaveformWebGL(color, timeDomain) {
  if (!gl || !glWaveProgram) return;
  resizeGlCanvas();
  const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  const widthPx = glCanvas.width;
  const heightPx = glCanvas.height;

  gl.viewport(0, 0, widthPx, heightPx);
  gl.clearColor(0,0,0,0);
  gl.clear(gl.COLOR_BUFFER_BIT);

  // Resample time-domain data to waveResolution points
  const len = timeDomain.length;
  const N = Math.max(2, Math.min(len, waveResolution));
  const step = (len - 1) / (N - 1);
  const verts = new Float32Array(N * 2);
  for (let i = 0; i < N; i++) {
    const idx = i * step;
    const i0 = Math.floor(idx);
    const t = idx - i0;
    const a = timeDomain[i0] || 128;
    const b = timeDomain[Math.min(i0 + 1, len - 1)] || 128;
    const s = a * (1 - t) + b * t; // 0..255
    const y = (s - 128) / 128;     // -1..1
    const x = i / (N - 1);         // 0..1
    verts[i * 2 + 0] = x;
    verts[i * 2 + 1] = y;
  }

  gl.useProgram(glWaveProgram);
  gl.bindBuffer(gl.ARRAY_BUFFER, waveVbo);
  gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  const col = hexOrRgbaToVec4(color);
  const u_res = gl.getUniformLocation(glWaveProgram, 'u_resolution');
  const u_pad = gl.getUniformLocation(glWaveProgram, 'u_padding');
  const u_col = gl.getUniformLocation(glWaveProgram, 'u_color');
  gl.uniform2f(u_res, widthPx, heightPx);
  gl.uniform1f(u_pad, paddingPx * dpr);
  gl.uniform4f(u_col, col[0], col[1], col[2], col[3]);

  if (gl.LINE_SMOOTH) gl.enable(gl.LINE_SMOOTH);
  gl.lineWidth(Math.max(1, Math.min(10, waveformThickness * dpr)));
  gl.drawArrays(gl.LINE_STRIP, 0, N);
}

function renderCirclePerimeterWebGL(values, color) {
  if (!gl) return;
  resizeGlCanvas();
  const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  const widthPx = glCanvas.width;
  const heightPx = glCanvas.height;

  gl.viewport(0, 0, widthPx, heightPx);
  gl.clearColor(0,0,0,0);
  gl.clear(gl.COLOR_BUFFER_BIT);

  const numBars = Math.min(values.length, 512);
  if (instanceCount !== numBars) {
    instanceCount = numBars;
  }

  // Circle parameters: center and radius (in pixels, accounting for aspect ratio)
  const centerX = widthPx * 0.5;
  const centerY = heightPx * 0.5;
  // Use the smaller dimension to ensure a perfect circle
  const shortSide = Math.min(widthPx, heightPx);
  const maxRadius = shortSide * 0.4;
  const innerRadius = maxRadius * 0.2; // inner ring start

  // Build instance arrays for radial bars
  const xs = new Float32Array(numBars);
  const ws = new Float32Array(numBars);
  const hs = new Float32Array(numBars);
  
  for (let i = 0; i < numBars; i++) {
    const angle = (i / numBars) * Math.PI * 2; // 0..2π
    // Normalized x position (angle as 0..1 for shader reuse)
    xs[i] = i / numBars;
    // Bar width in normalized space (angular extent)
    ws[i] = 1.0 / numBars;
    // Bar height (radial extent)
    const h = Math.max(minBarHeight / 100, values[i] / 100);
    hs[i] = h;
  }

  // Use a separate circle shader or reuse bar shader with polar transform
  // For simplicity, we'll draw radial quads manually using the bar shader
  // but transform the instance data to polar coordinates in a custom path
  // For now, render using a simple radial layout in the existing bar shader
  // (This is a placeholder; we'll render bars radiating outward)

  gl.bindBuffer(gl.ARRAY_BUFFER, quadVbo);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  gl.bindBuffer(gl.ARRAY_BUFFER, instXVbo);
  gl.bufferData(gl.ARRAY_BUFFER, xs, gl.DYNAMIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, instWidthVbo);
  gl.bufferData(gl.ARRAY_BUFFER, ws, gl.DYNAMIC_DRAW);
  gl.bindBuffer(gl.ARRAY_BUFFER, instHeightVbo);
  gl.bufferData(gl.ARRAY_BUFFER, hs, gl.DYNAMIC_DRAW);

  const col = hexOrRgbaToVec4(color);
  gl.useProgram(glProgram);
  
  // Override uniforms for circular layout
  // We'll draw each bar rotated around the center
  // For now, use a simple approximation: draw bars in a circle
  // (This requires a custom shader; as a quick solution we'll render a line-based circle waveform)
  
  // Render radial bars as line segments
  const verts = new Float32Array(numBars * 2 * 2); // pairs of (inner, outer) points
  for (let i = 0; i < numBars; i++) {
    const angle = (i / numBars) * Math.PI * 2;
    const h = Math.max(minBarHeight / 100, values[i] / 100);
    const r1 = innerRadius;
    const r2 = innerRadius + h * (maxRadius - innerRadius);
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);
    
    // Pixel coords
    const x1Px = centerX + r1 * cosA;
    const y1Px = centerY + r1 * sinA;
    const x2Px = centerX + r2 * cosA;
    const y2Px = centerY + r2 * sinA;
    
    // Convert to NDC
    verts[i * 4 + 0] = (x1Px / widthPx) * 2 - 1;
    verts[i * 4 + 1] = -((y1Px / heightPx) * 2 - 1);
    verts[i * 4 + 2] = (x2Px / widthPx) * 2 - 1;
    verts[i * 4 + 3] = -((y2Px / heightPx) * 2 - 1);
  }

  // Use waveform program to draw lines
  gl.useProgram(glWaveProgram);
  gl.bindBuffer(gl.ARRAY_BUFFER, waveVbo);
  gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  const u_res = gl.getUniformLocation(glWaveProgram, 'u_resolution');
  const u_pad = gl.getUniformLocation(glWaveProgram, 'u_padding');
  const u_col = gl.getUniformLocation(glWaveProgram, 'u_color');
  gl.uniform2f(u_res, widthPx, heightPx);
  gl.uniform1f(u_pad, 0); // no padding offset for manual NDC
  gl.uniform4f(u_col, col[0], col[1], col[2], col[3]);

  gl.lineWidth(Math.max(1, 2 * dpr));
  gl.drawArrays(gl.LINES, 0, numBars * 2);
}

function renderCircleWaveformWebGL(color, timeDomain) {
  if (!gl || !glWaveProgram) return;
  resizeGlCanvas();
  const dpr = Math.max(1, Math.min(3, window.devicePixelRatio || 1));
  const widthPx = glCanvas.width;
  const heightPx = glCanvas.height;

  gl.viewport(0, 0, widthPx, heightPx);
  gl.clearColor(0,0,0,0);
  gl.clear(gl.COLOR_BUFFER_BIT);

  const centerX = widthPx * 0.5;
  const centerY = heightPx * 0.5;
  const shortSide = Math.min(widthPx, heightPx);
  const baseRadius = shortSide * 0.35;

  // Resample time-domain data
  const len = timeDomain.length;
  const N = Math.max(2, Math.min(len, waveResolution));
  const step = (len - 1) / (N - 1);
  const verts = new Float32Array(N * 2);
  
  for (let i = 0; i < N; i++) {
    const idx = i * step;
    const i0 = Math.floor(idx);
    const t = idx - i0;
    const a = timeDomain[i0] || 128;
    const b = timeDomain[Math.min(i0 + 1, len - 1)] || 128;
    const s = a * (1 - t) + b * t; // 0..255
    const amp = (s - 128) / 128;   // -1..1
    
    const angle = (i / N) * Math.PI * 2;
    const r = baseRadius * (1 + amp * 0.3); // modulate radius
    
    // Pixel coords
    const xPx = centerX + r * Math.cos(angle);
    const yPx = centerY + r * Math.sin(angle);
    
    // Convert to NDC
    verts[i * 2 + 0] = (xPx / widthPx) * 2 - 1;
    verts[i * 2 + 1] = -((yPx / heightPx) * 2 - 1);
  }

  gl.useProgram(glWaveProgram);
  gl.bindBuffer(gl.ARRAY_BUFFER, waveVbo);
  gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

  const col = hexOrRgbaToVec4(color);
  const u_res = gl.getUniformLocation(glWaveProgram, 'u_resolution');
  const u_pad = gl.getUniformLocation(glWaveProgram, 'u_padding');
  const u_col = gl.getUniformLocation(glWaveProgram, 'u_color');
  gl.uniform2f(u_res, widthPx, heightPx);
  gl.uniform1f(u_pad, 0); // manual NDC, no padding
  gl.uniform4f(u_col, col[0], col[1], col[2], col[3]);

  if (gl.LINE_SMOOTH) gl.enable(gl.LINE_SMOOTH);
  gl.lineWidth(Math.max(1, Math.min(10, waveformThickness * dpr)));
  // Close the loop by drawing back to first point
  gl.drawArrays(gl.LINE_LOOP, 0, N);
}

function stopRendering() {
  if (animFrame) {
    cancelAnimationFrame(animFrame);
    animFrame = null;
  }
  isAudioRunning = false;
}

function processFrequencyData(dataArray, bufferLength) {
  const fftSize = bufferLength * 2;
  const nyquist = sampleRate / 2;
  const fMin = Math.max(1, minFrequencyHz || 20);
  const fMax = Math.min(nyquist, maxFrequencyHz || nyquist);

  // Compute usable bin range and cap output bars to 512
  const startIndex = Math.max(1, Math.floor((fMin * fftSize) / sampleRate)); // skip DC
  const endIndex = Math.max(startIndex + 1, Math.min(bufferLength, Math.floor((fMax * fftSize) / sampleRate)));
  const usableBins = endIndex - startIndex;
  const targetBars = Math.max(8, Math.min(usableBins, 512));

  // Prepare log spacing if enabled
  let processed = new Array(targetBars).fill(0);
  let bandCounts = new Array(targetBars).fill(0);

  const idxToFreq = (i) => (i * sampleRate) / fftSize;
  
  if (useLogFrequencyScale) {
    const logMin = Math.log(fMin);
    const logMax = Math.log(fMax);
    const N = Math.min(targetBars, usableBins);
    // Build log-spaced frequency edges
    const fEdges = new Array(N + 1);
    for (let k = 0; k <= N; k++) {
      const t = k / N;
      fEdges[k] = Math.exp(logMin + (logMax - logMin) * t);
    }
    // Map to float bin indices
    const edgeIdxF = fEdges.map(f => (f * fftSize) / sampleRate);
    let prevHi = startIndex;
    let out = 0;
    while (out < N) {
      const loF = edgeIdxF[out];
      const hiF = edgeIdxF[out + 1];
      let iLo = Math.max(startIndex, Math.floor(loF));
      let iHi = Math.max(iLo + 1, Math.min(endIndex, Math.ceil(hiF)));
      // Enforce contiguous, non-overlapping bands
      iLo = Math.max(iLo, prevHi);
      iHi = Math.max(iHi, iLo + 1);
      if (iLo >= endIndex) break;
      if (iHi > endIndex) iHi = endIndex;

      // Center frequency for this band (geometric mean of edges)
      const fLoEdge = Math.exp(logMin + (logMax - logMin) * (out / N));
      const fHiEdge = Math.exp(logMin + (logMax - logMin) * ((out + 1) / N));
      const fCenter = Math.sqrt(fLoEdge * fHiEdge);
      const gainDb = tiltDbPerOctave * (Math.log(fCenter / tiltRefHz) / Math.LN2);

      let energy = 0;
      let cnt = 0;
      for (let i = iLo; i < iHi; i++) {
        let v = dataArray[i] || 0;
        const prev = previousFft[i] || 0;
        v = prev * frequencySmoothing + v * (1 - frequencySmoothing);
        previousFft[i] = v;
        const vn = v / 255;
        if (aggregateWithEnergy) {
          energy += vn * vn; // sum of squares (power)
        } else {
          // fallback to mean magnitude later
          energy += vn;
        }
        cnt++;
      }
      if (cnt > 0) {
        if (aggregateWithEnergy) {
          const energyNorm = compensateBandwidth ? (energy / cnt) : energy; // average power or sum power
          // Convert to dB, apply tilt, normalize to 0..100
          if (useDecibelScale) {
            const energyDb = 10 * Math.log10(Math.max(1e-12, energyNorm));
            const adjDb = energyDb + gainDb;
            const norm = Math.min(1, Math.max(0, (adjDb - dbFloor) / (0 - dbFloor)));
            processed[out] = norm * 100;
          } else {
            // Map RMS amplitude to 0..100
            const amp = Math.sqrt(energyNorm);
            processed[out] = Math.min(100, Math.max(0, amp * 100));
          }
        } else {
          // Mean magnitude path (legacy)
          const meanMag = energy / cnt;
          if (useDecibelScale) {
            const db = 20 * Math.log10(Math.max(1e-6, meanMag));
            const adjDb = db + gainDb;
            const norm = Math.min(1, Math.max(0, (adjDb - dbFloor) / (0 - dbFloor)));
            processed[out] = norm * 100;
          } else {
            processed[out] = Math.min(100, Math.max(0, meanMag * 100));
          }
        }
      } else {
        processed[out] = 0;
      }
      bandCounts[out] = cnt;
      prevHi = iHi;
      out++;
      if (prevHi >= endIndex) break;
    }
    // If fewer bands produced due to bin constraints, truncate
    if (processed.length > out) processed = processed.slice(0, out);
  } else {
    // Linear bins (skip DC), apply per-bin smoothing and optional dB scaling
    let outIdx = 0;
    for (let i = startIndex; i < endIndex && outIdx < targetBars; i++, outIdx++) {
      let v = dataArray[i] || 0;
      const prev = previousFft[i] || 0;
      v = prev * frequencySmoothing + v * (1 - frequencySmoothing);
      previousFft[i] = v;
      const vn = v / 255;
      if (aggregateWithEnergy) {
        const energy = vn * vn;
        if (useDecibelScale) {
          const energyDb = 10 * Math.log10(Math.max(1e-12, energy));
          const norm = Math.min(1, Math.max(0, (energyDb - dbFloor) / (0 - dbFloor)));
          processed[outIdx] = norm * 100;
        } else {
          const amp = Math.sqrt(energy);
          processed[outIdx] = Math.min(100, Math.max(0, amp * 100));
        }
      } else {
        if (useDecibelScale) {
          const db = 20 * Math.log10(Math.max(1e-6, vn));
          const norm = Math.min(1, Math.max(0, (db - dbFloor) / (0 - dbFloor)));
          processed[outIdx] = norm * 100;
        } else {
          processed[outIdx] = Math.min(100, Math.max(0, vn * 100));
        }
      }
    }
  }

  return processed;
}

function interpolateValues(values) {
  const interpolated = [];
  for (let i = 0; i < values.length - 1; i++) {
    interpolated.push(values[i]);
    // Add interpolated value between current and next
    const interpolatedValue = (values[i] + values[i + 1]) / 2;
    interpolated.push(interpolatedValue);
  }
  interpolated.push(values[values.length - 1]);
  return interpolated;
}

function updateVisualization(values, color) {
  if (visualMode === 'linear') {
    updateLinearVisualization(values, color);
  } else if (visualMode === 'circle-perimeter') {
    updateCirclePerimeterVisualization(values, color);
  } else if (visualMode === 'circle-waveform') {
    updateCircleWaveformVisualization(values, color);
  }
}

function updateLinearVisualization(values, color) {
  // Deprecated - replaced by WebGL path
}

function updateCirclePerimeterVisualization(values, color) {
  // TODO: WebGL circular mode not yet implemented; fallback handled in render path
}

function updateCircleWaveformVisualization(values, color) {
  // TODO: WebGL circular mode not yet implemented; fallback handled in render path
}

// Drag, resize, and rotate functionality
function setupDragAndResize() {
  const container = document.getElementById('visualizer-container');
  const resizeHandle = document.getElementById('resize-handle');
  const centerDot = document.getElementById('center-dot');
  // no arrow rotation
  
  // Drag functionality
  container.addEventListener('mousedown', (e) => {
    if (e.target === resizeHandle || e.target === centerDot) return;
    isDragging = true;
    const rect = container.getBoundingClientRect();
    // Compute offset between mouse and container top-left
    dragStart.x = e.clientX - rect.left;
    dragStart.y = e.clientY - rect.top;
    container.style.cursor = 'grabbing';
  });
  
  // Resize functionality
  resizeHandle.addEventListener('mousedown', (e) => {
    e.stopPropagation();
    isResizing = true;
    resizeStart.x = e.clientX;
    resizeStart.y = e.clientY;
    resizeStart.width = container.offsetWidth;
    resizeStart.height = container.offsetHeight;
    container.classList.add('resizing');
  });
  
  // Rotate functionality via center dot (original behavior)
  centerDot.addEventListener('mousedown', (e) => {
    e.stopPropagation();
    isRotating = true;
    const rect = container.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    rotationStart.x = e.clientX - centerX;
    rotationStart.y = e.clientY - centerY;
    rotationStart.angle = currentRotation;
  });
  
  // Mouse move
  document.addEventListener('mousemove', (e) => {
    if (isDragging) {
      const newX = e.clientX - dragStart.x;
      const newY = e.clientY - dragStart.y;
      // Allow free movement within the window
      const snappedX = Math.round(newX);
      const snappedY = Math.round(newY);
      container.style.left = `${snappedX}px`;
      container.style.top = `${snappedY}px`;
    }
    
    if (isResizing) {
      const deltaX = e.clientX - resizeStart.x;
      const deltaY = e.clientY - resizeStart.y;
      
      const newWidth = Math.max(200, resizeStart.width + deltaX);
      const newHeight = Math.max(100, resizeStart.height + deltaY);
      
      container.style.width = `${newWidth}px`;
      container.style.height = `${newHeight}px`;
    }
    
    if (isRotating) {
      const rect = container.getBoundingClientRect();
      const centerX = rect.left + rect.width / 2;
      const centerY = rect.top + rect.height / 2;
      
      const deltaX = e.clientX - centerX;
      const deltaY = e.clientY - centerY;
      
      const angle = Math.atan2(deltaY, deltaX) * (180 / Math.PI);
      currentRotation = rotationStart.angle + (angle - Math.atan2(rotationStart.y, rotationStart.x) * (180 / Math.PI));
      container.style.transform = `rotate(${currentRotation}deg)`;
    }
  });
  
  // Mouse up
  document.addEventListener('mouseup', () => {
    if (isDragging) {
      isDragging = false;
      container.style.cursor = 'move';
    }
    
    if (isResizing) {
      isResizing = false;
      container.classList.remove('resizing');
    }
    
    if (isRotating) {
      isRotating = false;
    }
  });
}

// After Loaded //

document.addEventListener("DOMContentLoaded", () => {
  // Listen for fill smooth line toggle
  window.electron.ipcRenderer.on("fill-smooth-line-toggle", (event, enabled) => {
    window.fillSmoothLine = !!enabled;
  });
  visualizerContainer = document.getElementById("visualizer-container");
  visualizerElement = document.getElementById("visualizer");
  glCanvas = document.getElementById("gl-canvas");
  
  if (!visualizerContainer || !visualizerElement) {
    const errorMsg = "Visualizer elements not found!";
    console.error(errorMsg);
    alert(errorMsg); // DEBUG: show error as alert
    return;
  }

  console.log("Visualizer elements found successfully");
  alert("Visualizer initialized - elements found"); // DEBUG

  // Center the container numerically (avoid translate(-50%, -50%) so drag doesn't jump)
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const cw = Math.max(visualizerContainer.offsetWidth || 600, 400);
  const ch = Math.max(visualizerContainer.offsetHeight || 300, 200);
  const cx = Math.round((vw - cw) / 2);
  const cy = Math.round((vh - ch) / 2);
  visualizerContainer.style.left = `${Math.max(0, cx)}px`;
  visualizerContainer.style.top = `${Math.max(0, cy)}px`;

  // Setup drag and resize functionality
  setupDragAndResize();

  var fft_size = 256;
  var noise_intensity = 10;
  var color = "rgba(255, 255, 255, 0.8)";

  // Restore position/size/rotation if present in settings
  let restoreVizPosSizeRot = null;

  // Listen for toggle drag message from the main process
  window.electron.ipcRenderer.on("drag-state", (event, drag_state) => {
    if (drag_state == true) {
      // Enter edit mode - show border and controls
      visualizerContainer.classList.add("edit-mode");
      visualizerContainer.style.pointerEvents = "auto";
    } else {
      // Exit edit mode - hide border and controls
      visualizerContainer.classList.remove("edit-mode");
      visualizerContainer.style.pointerEvents = "none";
    }
  });

  window.electron.ipcRenderer.on("color-selected", (event, value) => {
    color = value;
    renderColor = value;
  });

  window.electron.ipcRenderer.on("noise-change", (event, value) => {
    noise_intensity = value;
    // No need to restart audio, just update the noise intensity
  });

  window.electron.ipcRenderer.on("min-bar-height-change", (event, value) => {
    minBarHeight = Math.max(0, Math.min(10, value)); // 0-10% range
  });

  window.electron.ipcRenderer.on("waveform-thickness-change", (event, value) => {
    waveformThickness = Math.max(0.5, Math.min(10, value));
  });

  window.electron.ipcRenderer.on("resolution-change", (event, value) => {
    fft_size = value;
    // Only restart audio when resolution changes
    initializeAudio(deviceName, fft_size);
  });

  // New IPC listeners for visualization modes
  window.electron.ipcRenderer.on("visual-mode-change", (event, mode) => {
    visualMode = mode;
    // No need to restart audio, just change the visualization mode
  });

  // New IPC toggles for spectrum processing
  window.electron.ipcRenderer.on('viz-toggle-energy', (e, enabled) => {
    aggregateWithEnergy = !!enabled;
  });
  window.electron.ipcRenderer.on('viz-toggle-bandwidth-comp', (e, enabled) => {
    compensateBandwidth = !!enabled;
  });
  window.electron.ipcRenderer.on('viz-toggle-log-scale', (e, enabled) => {
    useLogFrequencyScale = !!enabled;
  });
  window.electron.ipcRenderer.on('viz-toggle-db-scale', (e, enabled) => {
    useDecibelScale = !!enabled;
  });
  window.electron.ipcRenderer.on('viz-tilt-db-per-oct', (e, value) => {
    const v = Number(value);
    if (!Number.isNaN(v)) tiltDbPerOctave = v;
  });
  window.electron.ipcRenderer.on('viz-min-frequency', (e, value) => {
    const v = Number(value);
    if (!Number.isNaN(v) && v >= 1) minFrequencyHz = v;
  });
  window.electron.ipcRenderer.on('viz-db-floor', (e, value) => {
    const v = Number(value);
    if (!Number.isNaN(v)) dbFloor = v;
  });

  window.electron.ipcRenderer.on("smooth-interpolation-toggle", (event, enabled) => {
    smoothInterpolation = enabled;
  });

  window.electron.ipcRenderer.on("smooth-transitions-toggle", (event, enabled) => {
    smoothTransitions = enabled;
  });

  window.electron.ipcRenderer.send("log", "IPC communication initialized");

  // Resize observer to keep WebGL canvas in sync with container size and DPR
  const resizeObserver = new ResizeObserver(() => {
    resizeGlCanvas();
  });
  resizeObserver.observe(visualizerElement);

  // Capture Internal Audio from Blackhole
  const deviceName = "BlackHole 2ch";

  window.electron.ipcRenderer.send("Load-Settings-Data-Request");
  
  window.electron.ipcRenderer.on("Start-Up-Data", async (event, data) => {
    // Defensive: fallback to empty object if data is null/undefined
    data = data || {};
    // Defensive: fallback for each field
    color = (data.color !== undefined && data.color !== null) ? data.color : color;
    renderColor = color;
    fft_size = (data.resolution !== undefined && data.resolution !== null) ? data.resolution : fft_size;
    noise_intensity = (data.noiseIntensity !== undefined && data.noiseIntensity !== null) ? data.noiseIntensity : noise_intensity;
    minBarHeight = (data.minBarHeight !== undefined && data.minBarHeight !== null) ? data.minBarHeight : 0;
    visualMode = (data.visualMode !== undefined && data.visualMode !== null) ? data.visualMode : 'linear';
    smoothInterpolation = (data.smoothInterpolation !== undefined && data.smoothInterpolation !== null) ? data.smoothInterpolation : false;
    smoothTransitions = (data.smoothTransitions !== undefined && data.smoothTransitions !== null) ? data.smoothTransitions : false;

    // Restore processing options if present
    if (data.processing) {
      aggregateWithEnergy = (typeof data.processing.aggregateWithEnergy === 'boolean') ? data.processing.aggregateWithEnergy : aggregateWithEnergy;
      compensateBandwidth = (typeof data.processing.compensateBandwidth === 'boolean') ? data.processing.compensateBandwidth : compensateBandwidth;
      useLogFrequencyScale = (typeof data.processing.useLogFrequencyScale === 'boolean') ? data.processing.useLogFrequencyScale : useLogFrequencyScale;
      useDecibelScale = (typeof data.processing.useDecibelScale === 'boolean') ? data.processing.useDecibelScale : useDecibelScale;
      tiltDbPerOctave = (typeof data.processing.tiltDbPerOctave === 'number') ? data.processing.tiltDbPerOctave : tiltDbPerOctave;
      minFrequencyHz = (typeof data.processing.minFrequencyHz === 'number') ? data.processing.minFrequencyHz : minFrequencyHz;
      dbFloor = (typeof data.processing.dbFloor === 'number') ? data.processing.dbFloor : dbFloor;
    }

    // Restore visualizer position/size/rotation if present
    if (data.vizPosSizeRot) {
      restoreVizPosSizeRot = data.vizPosSizeRot;
      // Restore position
      if (restoreVizPosSizeRot.left !== undefined && restoreVizPosSizeRot.top !== undefined) {
        visualizerContainer.style.left = `${restoreVizPosSizeRot.left}px`;
        visualizerContainer.style.top = `${restoreVizPosSizeRot.top}px`;
      }
      // Restore size
      if (restoreVizPosSizeRot.width && restoreVizPosSizeRot.height) {
        visualizerContainer.style.width = `${restoreVizPosSizeRot.width}px`;
        visualizerContainer.style.height = `${restoreVizPosSizeRot.height}px`;
      }
      // Restore rotation
      if (restoreVizPosSizeRot.rotation !== undefined) {
        currentRotation = restoreVizPosSizeRot.rotation;
        visualizerContainer.style.transform = `rotate(${currentRotation}deg)`;
      }
    }

    // Initialize audio and start rendering
    const audioInitialized = await initializeAudio(deviceName, fft_size);
    if (audioInitialized) {
      startRendering(noise_intensity);
    }
  });

  // Position restoration IPC removed since window remains full workArea

  window.electron.ipcRenderer.on("Settings-Data-Request", () => {
    // Save visualizer container position, size, and rotation
    const rect = visualizerContainer.getBoundingClientRect();
    let rotation = 0;
    const style = window.getComputedStyle(visualizerContainer);
    const transform = style.transform;
    if (transform && transform !== 'none') {
      // Parse matrix for rotation
      const values = transform.split('(')[1].split(')')[0].split(',');
      if (values.length >= 4) {
        const a = parseFloat(values[0]);
        const b = parseFloat(values[1]);
        rotation = Math.round(Math.atan2(b, a) * (180 / Math.PI));
      }
    }
    const vizPosSizeRot = {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
      rotation: rotation
    };
    // Save all processing options
    const processing = {
      aggregateWithEnergy,
      compensateBandwidth,
      useLogFrequencyScale,
      useDecibelScale,
      tiltDbPerOctave,
      minFrequencyHz,
      dbFloor
    };
    window.electron.ipcRenderer.send("Settings-Data-Transfer", [
      color, 
      noise_intensity, 
      fft_size,
      visualMode,
      smoothInterpolation,
      smoothTransitions,
      minBarHeight,
      vizPosSizeRot,
      processing
    ]);
  });
});