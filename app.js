/**
 * Snap & Vanish
 * Parmağını şıklat, moleküllerine ayrıl ve kaybol!
 * 
 * Uses:
 * - MediaPipe Selfie Segmentation (person vs background)
 * - Web Audio API (snap sound detection)
 * - Canvas pixel manipulation (particle disintegration)
 */

// ============================
// DOM
// ============================
const setupOverlay = document.getElementById('setup-overlay');
const stepWelcome = document.getElementById('step-welcome');
const stepBackground = document.getElementById('step-background');
const stepReady = document.getElementById('step-ready');
const setupPreview = document.getElementById('setup-preview');
const countdownOverlay = document.getElementById('countdown-overlay');
const countdownNum = document.getElementById('countdown-num');

const appEl = document.getElementById('app');
const webcam = document.getElementById('webcam');
const bgCanvas = document.getElementById('bg-canvas');
const personCanvas = document.getElementById('person-canvas');
const particleCanvas = document.getElementById('particle-canvas');
const bgCtx = bgCanvas.getContext('2d', { willReadFrequently: true });
const personCtx = personCanvas.getContext('2d', { willReadFrequently: true });
const particleCtx = particleCanvas.getContext('2d');
const audioLevelEl = document.getElementById('audio-level');
const statusIndicator = document.getElementById('status-indicator');
const statusLabel = document.getElementById('status-label');
const snapFlash = document.getElementById('snap-flash');
const snapVisual = document.getElementById('snap-visual');
const toggleIcon = document.getElementById('toggle-icon');
const sensitivitySlider = document.getElementById('sensitivity');

// ============================
// State
// ============================
let stream = null;
let backgroundImage = null; // Captured background (canvas element)
let segmentationMask = null;
let selfieSegmentation = null;

let isVisible = true;
let isAnimating = false;
let dissolveAmount = 0; // 0 = fully visible, 1 = fully dissolved

// Particle system
let particles = [];
let personSnapshot = null; // ImageData of the person at moment of snap

// Audio
let audioContext = null;
let analyser = null;
let lastSnapTime = 0;
const SNAP_COOLDOWN = 1500;

// Canvas dimensions
let W = 1280;
let H = 720;

// ============================
// Setup Flow
// ============================
document.getElementById('btn-start').addEventListener('click', async () => {
    try {
        stream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
            audio: true
        });

        webcam.srcObject = stream;
        setupPreview.srcObject = stream;
        await webcam.play();
        await setupPreview.play();

        W = webcam.videoWidth || 1280;
        H = webcam.videoHeight || 720;
        bgCanvas.width = W;
        bgCanvas.height = H;
        personCanvas.width = W;
        personCanvas.height = H;
        particleCanvas.width = W;
        particleCanvas.height = H;

        // Setup audio
        setupAudio(stream);

        // Switch to background step
        stepWelcome.classList.add('hidden');
        stepBackground.classList.remove('hidden');
    } catch (err) {
        alert('Kamera ve mikrofon izni gerekli! Lütfen izin ver ve sayfayı yenile.');
        console.error(err);
    }
});

document.getElementById('btn-capture-bg').addEventListener('click', () => {
    // Start 3-second countdown
    countdownOverlay.classList.remove('hidden');
    let count = 3;
    countdownNum.textContent = count;

    const interval = setInterval(() => {
        count--;
        if (count > 0) {
            countdownNum.textContent = count;
            countdownNum.style.animation = 'none';
            void countdownNum.offsetWidth;
            countdownNum.style.animation = '';
        } else {
            clearInterval(interval);
            // Capture background
            captureBackground();
            countdownOverlay.classList.add('hidden');

            // Move to ready step
            setTimeout(() => {
                stepBackground.classList.add('hidden');
                stepReady.classList.remove('hidden');
            }, 400);
        }
    }, 1000);
});

document.getElementById('btn-go').addEventListener('click', () => {
    // Hide setup, show app
    setupOverlay.classList.add('fade-out');
    setTimeout(() => {
        setupOverlay.style.display = 'none';
        appEl.classList.remove('hidden');
        // Start segmentation & render
        initSegmentation();
    }, 500);
});

// Recapture background
document.getElementById('btn-recapture').addEventListener('click', () => {
    captureBackground();
    showFlash();
});

// Manual toggle
document.getElementById('btn-toggle').addEventListener('click', () => {
    triggerSnap();
});

// Keyboard shortcut
document.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !e.repeat) {
        e.preventDefault();
        triggerSnap();
    }
});

// ============================
// Background Capture
// ============================
function captureBackground() {
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(webcam, 0, 0, W, H);
    backgroundImage = canvas;
    console.log('Background captured!');
}

// ============================
// MediaPipe Segmentation
// ============================
function initSegmentation() {
    selfieSegmentation = new SelfieSegmentation({
        locateFile: (file) =>
            `https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/${file}`,
    });

    selfieSegmentation.setOptions({
        modelSelection: 1,
        selfieMode: true,
    });

    selfieSegmentation.onResults(onResults);

    // Start processing loop
    processFrame();
}

async function processFrame() {
    if (webcam.readyState >= 2 && selfieSegmentation) {
        try {
            await selfieSegmentation.send({ image: webcam });
        } catch (e) {
            // Ignore occasional frame errors
        }
    }
    requestAnimationFrame(processFrame);
}

function onResults(results) {
    segmentationMask = results.segmentationMask;
    render(results.image);
}

// ============================
// Main Render
// ============================
function render(sourceImage) {
    if (!backgroundImage || !segmentationMask) {
        // Fallback: just show mirrored webcam
        bgCtx.save();
        bgCtx.translate(W, 0);
        bgCtx.scale(-1, 1);
        bgCtx.drawImage(sourceImage, 0, 0, W, H);
        bgCtx.restore();
        personCtx.clearRect(0, 0, W, H);
        return;
    }

    // === Layer 1: Background ===
    // Always show the captured background (mirrored)
    bgCtx.save();
    bgCtx.translate(W, 0);
    bgCtx.scale(-1, 1);
    bgCtx.drawImage(backgroundImage, 0, 0, W, H);
    bgCtx.restore();

    // === Layer 2: Person ===
    // Draw person using segmentation mask
    personCtx.clearRect(0, 0, W, H);

    if (dissolveAmount < 1) {
        // Create person cutout
        const tempCanvas = document.createElement('canvas');
        tempCanvas.width = W;
        tempCanvas.height = H;
        const tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true });

        // Draw the source video frame
        tempCtx.drawImage(sourceImage, 0, 0, W, H);

        // Mask with segmentation
        tempCtx.globalCompositeOperation = 'destination-in';
        tempCtx.drawImage(segmentationMask, 0, 0, W, H);
        tempCtx.globalCompositeOperation = 'source-over';

        // Apply dissolve: remove blocks of the person
        if (dissolveAmount > 0) {
            const imageData = tempCtx.getImageData(0, 0, W, H);
            applyDissolvePixels(imageData.data, W, H, dissolveAmount);
            tempCtx.putImageData(imageData, 0, 0);
        }

        // Draw to person layer (mirrored)
        personCtx.save();
        personCtx.translate(W, 0);
        personCtx.scale(-1, 1);
        personCtx.drawImage(tempCanvas, 0, 0);
        personCtx.restore();
    }

    // === Layer 3: Particles ===
    renderParticles();

    // Update dissolve animation
    updateDissolveAnimation();
}

// ============================
// Dissolve Pixel Effect
// ============================
function applyDissolvePixels(data, w, h, progress) {
    // Block-based dissolve with organic noise pattern
    const blockSize = 6;
    const cols = Math.ceil(w / blockSize);
    const rows = Math.ceil(h / blockSize);

    for (let by = 0; by < rows; by++) {
        for (let bx = 0; bx < cols; bx++) {
            // Noise value for this block (0-1)
            const noise = hash2D(bx, by);

            // Add wave pattern for more organic look
            const wave = Math.sin(bx * 0.1 + by * 0.15 + progress * 5) * 0.1;
            const threshold = noise + wave;

            if (threshold < progress) {
                // Dissolve this block
                const fadeStrength = Math.min(1, (progress - threshold) * 4);
                const startX = bx * blockSize;
                const startY = by * blockSize;
                const endX = Math.min(startX + blockSize, w);
                const endY = Math.min(startY + blockSize, h);

                for (let y = startY; y < endY; y++) {
                    for (let x = startX; x < endX; x++) {
                        const idx = (y * w + x) * 4;
                        data[idx + 3] = Math.floor(data[idx + 3] * (1 - fadeStrength));
                    }
                }
            }
        }
    }
}

function hash2D(x, y) {
    let n = x * 374761393 + y * 668265263;
    n = (n ^ (n >> 13)) * 1274126177;
    return ((n ^ (n >> 16)) & 0x7fffffff) / 0x7fffffff;
}

// ============================
// Dissolve Animation
// ============================
function updateDissolveAnimation() {
    if (!isAnimating) return;

    const target = isVisible ? 0 : 1;
    const speed = 0.015; // ~66 frames for full transition

    if (target > dissolveAmount) {
        dissolveAmount = Math.min(dissolveAmount + speed, 1);
    } else {
        dissolveAmount = Math.max(dissolveAmount - speed * 1.3, 0); // Reappear slightly faster
    }

    if (Math.abs(dissolveAmount - target) < 0.005) {
        dissolveAmount = target;
        isAnimating = false;
    }
}

// ============================
// Particle System — Molecular Disintegration
// ============================
function spawnDisintegrationParticles() {
    // Sample person pixels from the current frame to create colored particles
    if (!segmentationMask) return;

    // Get current person pixels
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = W;
    tempCanvas.height = H;
    const tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true });
    tempCtx.drawImage(webcam, 0, 0, W, H);

    // Get mask data
    const maskCanvas = document.createElement('canvas');
    maskCanvas.width = W;
    maskCanvas.height = H;
    const maskCtx = maskCanvas.getContext('2d');
    maskCtx.drawImage(segmentationMask, 0, 0, W, H);
    const maskData = maskCtx.getImageData(0, 0, W, H).data;

    // Get image data
    const imgData = tempCtx.getImageData(0, 0, W, H).data;

    // Sample particles from person region
    const sampleStep = 12; // Sample every Nth pixel for performance
    const maxParticles = 3000;
    let count = 0;

    for (let y = 0; y < H && count < maxParticles; y += sampleStep) {
        for (let x = 0; x < W && count < maxParticles; x += sampleStep) {
            const idx = (y * W + x) * 4;
            const maskAlpha = maskData[idx + 3] || maskData[idx]; // Check mask

            if (maskAlpha > 128) {
                // This pixel is on the person
                const r = imgData[idx];
                const g = imgData[idx + 1];
                const b = imgData[idx + 2];

                // Mirror x for display
                const mirroredX = W - x;

                // Add some randomization to spawn position
                const jitterX = (Math.random() - 0.5) * sampleStep;
                const jitterY = (Math.random() - 0.5) * sampleStep;

                particles.push({
                    x: mirroredX + jitterX,
                    y: y + jitterY,
                    // Velocity: outward from center with randomness
                    vx: (mirroredX - W / 2) * 0.004 + (Math.random() - 0.5) * 3,
                    vy: (y - H / 2) * 0.003 + (Math.random() - 0.5) * 2 - 1,
                    // Size varies — some larger "molecular clusters", some tiny
                    size: Math.random() < 0.1 ? 4 + Math.random() * 4 : 1 + Math.random() * 3,
                    r, g, b,
                    alpha: 1,
                    decay: 0.004 + Math.random() * 0.008,
                    delay: Math.random() * 40, // Stagger appearance
                    gravity: -0.01 - Math.random() * 0.02, // Slight upward float
                    rotation: Math.random() * Math.PI * 2,
                    rotSpeed: (Math.random() - 0.5) * 0.1,
                });
                count++;
            }
        }
    }
}

function spawnReappearParticles() {
    // Simpler effect for reappearing — particles converge inward
    const count = 800;
    for (let i = 0; i < count; i++) {
        const angle = Math.random() * Math.PI * 2;
        const dist = 200 + Math.random() * 400;
        const cx = W / 2;
        const cy = H / 2;

        particles.push({
            x: cx + Math.cos(angle) * dist,
            y: cy + Math.sin(angle) * dist,
            vx: -Math.cos(angle) * (2 + Math.random() * 3),
            vy: -Math.sin(angle) * (2 + Math.random() * 3),
            size: 1 + Math.random() * 3,
            r: 108 + Math.random() * 50,
            g: 99 + Math.random() * 50,
            b: 255,
            alpha: 1,
            decay: 0.008 + Math.random() * 0.01,
            delay: Math.random() * 20,
            gravity: 0,
            rotation: 0,
            rotSpeed: 0,
        });
    }
}

function renderParticles() {
    particleCtx.clearRect(0, 0, W, H);

    if (particles.length === 0) return;

    const remaining = [];

    for (const p of particles) {
        // Handle delay
        if (p.delay > 0) {
            p.delay--;
            remaining.push(p);
            continue;
        }

        // Update physics
        p.x += p.vx;
        p.y += p.vy;
        p.vy += p.gravity;
        p.vx *= 0.998; // Slight drag
        p.alpha -= p.decay;
        p.rotation += p.rotSpeed;

        if (p.alpha <= 0 || p.x < -50 || p.x > W + 50 || p.y < -50 || p.y > H + 50) {
            continue; // Dead particle
        }

        // Draw particle
        const a = Math.max(0, p.alpha);

        // Main particle body
        particleCtx.save();
        particleCtx.translate(p.x, p.y);
        particleCtx.rotate(p.rotation);

        // Inner glow
        particleCtx.globalAlpha = a * 0.3;
        particleCtx.fillStyle = `rgb(${p.r}, ${p.g}, ${p.b})`;
        particleCtx.beginPath();
        particleCtx.arc(0, 0, p.size * 2.5, 0, Math.PI * 2);
        particleCtx.fill();

        // Core particle (square-ish for molecular feel)
        particleCtx.globalAlpha = a;
        particleCtx.fillStyle = `rgb(${p.r}, ${p.g}, ${p.b})`;

        if (p.size > 3) {
            // Larger chunks are square-ish
            const s = p.size;
            particleCtx.fillRect(-s / 2, -s / 2, s, s);
        } else {
            // Smaller particles are circular
            particleCtx.beginPath();
            particleCtx.arc(0, 0, p.size, 0, Math.PI * 2);
            particleCtx.fill();
        }

        particleCtx.restore();

        remaining.push(p);
    }

    particles = remaining;
}

// ============================
// Snap Trigger
// ============================
function triggerSnap() {
    const now = Date.now();
    if (now - lastSnapTime < SNAP_COOLDOWN) return;
    if (!backgroundImage) {
        console.warn('No background captured!');
        return;
    }
    lastSnapTime = now;

    isVisible = !isVisible;
    isAnimating = true;

    // Update UI
    updateStatusUI();
    showFlash();
    showSnapVisual();

    // Spawn particles
    if (!isVisible) {
        // Disappearing — sample person colors and disintegrate
        spawnDisintegrationParticles();
    } else {
        // Reappearing — convergence effect
        spawnReappearParticles();
    }

    // Sound
    playSnapSound();
}

// ============================
// Audio Snap Detection
// ============================
function setupAudio(mediaStream) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    const source = audioContext.createMediaStreamSource(mediaStream);

    analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.3;
    source.connect(analyser);

    const bufferLength = analyser.frequencyBinCount;
    const freqData = new Uint8Array(bufferLength);
    const timeData = new Float32Array(analyser.fftSize);

    let rmsHistory = [];
    const HISTORY_SIZE = 50;

    function analyze() {
        analyser.getByteFrequencyData(freqData);
        analyser.getFloatTimeDomainData(timeData);

        // RMS loudness
        let rms = 0;
        for (let i = 0; i < timeData.length; i++) {
            rms += timeData[i] * timeData[i];
        }
        rms = Math.sqrt(rms / timeData.length);

        rmsHistory.push(rms);
        if (rmsHistory.length > HISTORY_SIZE) rmsHistory.shift();
        const avgRms = rmsHistory.reduce((a, b) => a + b, 0) / rmsHistory.length;

        // Frequency analysis — snaps have strong 2-8kHz content
        const sampleRate = audioContext.sampleRate;
        const binHz = sampleRate / analyser.fftSize;

        const hiStart = Math.floor(2000 / binHz);
        const hiEnd = Math.floor(8000 / binHz);
        let hiEnergy = 0;
        for (let i = hiStart; i < hiEnd && i < bufferLength; i++) {
            hiEnergy += freqData[i];
        }
        hiEnergy /= (hiEnd - hiStart);

        const loEnd = Math.floor(500 / binHz);
        let loEnergy = 0;
        for (let i = 0; i < loEnd && i < bufferLength; i++) {
            loEnergy += freqData[i];
        }
        loEnergy /= Math.max(1, loEnd);

        const spectralRatio = loEnergy > 0 ? hiEnergy / loEnergy : 0;

        // Audio level UI
        const level = Math.min(rms * 500, 100);
        audioLevelEl.style.width = level + '%';

        // Sensitivity
        const sens = parseInt(sensitivitySlider.value);
        const mult = 0.5 + (sens / 10) * 1.5;

        // Detection thresholds
        const rmsThreshold = Math.max(0.015, avgRms * (3.5 / mult));
        const isLoud = rms > rmsThreshold;
        const isSnappy = spectralRatio > (1.0 / mult);
        const isTransient = rms > avgRms * (3.5 / mult);

        const now = Date.now();
        if (isLoud && isSnappy && isTransient && (now - lastSnapTime > SNAP_COOLDOWN)) {
            triggerSnap();
        }

        requestAnimationFrame(analyze);
    }

    analyze();
}

// ============================
// UI Helpers
// ============================
function updateStatusUI() {
    if (isVisible) {
        statusIndicator.className = 'status-visible';
        statusLabel.textContent = 'Görünürsün';
        toggleIcon.textContent = '👻';
    } else {
        statusIndicator.className = 'status-invisible';
        statusLabel.textContent = 'Görünmezsin!';
        toggleIcon.textContent = '👤';
    }
}

function showFlash() {
    snapFlash.classList.remove('hidden');
    snapFlash.style.animation = 'none';
    void snapFlash.offsetWidth;
    snapFlash.style.animation = '';
    setTimeout(() => snapFlash.classList.add('hidden'), 500);
}

function showSnapVisual() {
    snapVisual.classList.remove('hidden');
    const circle = snapVisual.querySelector('.snap-circle');
    const text = snapVisual.querySelector('.snap-text');
    circle.style.animation = 'none';
    text.style.animation = 'none';
    void circle.offsetWidth;
    circle.style.animation = '';
    text.style.animation = '';
    text.textContent = isVisible ? '✨' : '🫰';
    setTimeout(() => snapVisual.classList.add('hidden'), 1000);
}

function playSnapSound() {
    if (!audioContext) return;
    const osc = audioContext.createOscillator();
    const gain = audioContext.createGain();
    osc.connect(gain);
    gain.connect(audioContext.destination);

    osc.type = 'sine';
    osc.frequency.setValueAtTime(isVisible ? 600 : 900, audioContext.currentTime);
    osc.frequency.exponentialRampToValueAtTime(
        isVisible ? 200 : 300,
        audioContext.currentTime + 0.12
    );

    gain.gain.setValueAtTime(0.1, audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + 0.15);

    osc.start(audioContext.currentTime);
    osc.stop(audioContext.currentTime + 0.15);
}

// ============================
// Init
// ============================
window.addEventListener('DOMContentLoaded', () => {
    console.log('Snap & Vanish loaded! 🫰');
});
