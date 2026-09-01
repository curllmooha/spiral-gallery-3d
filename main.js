import * as THREE from "three";

const gsap = window.gsap;
const Flip = window.Flip;
gsap.registerPlugin(Flip);

// --- CONFIGURATION ---
const CONFIG = {
  radius: 6,
  spiralStep: 0.8,
  imagesPerTurn: 7,
  curvature: 1.5,
  imageScale: 0.83,
  autoRotateSpeed: 0.001, // Reduced (from 0.002)
  scrollRotateForce: 0.5, // Much lower (from 1.75)
  rotationSmoothing: 0.1, // Slightly higher for more "weight"
  momentum: 0.75, // Lowered (from 0.87) - this makes it stop sooner
  scrollAdvanceSpeed: 0.5, // Lowered (from 0.17) - slows vertical movement
  squeezeIntensity: 0.5,
  squeezeWidth: 7.5,
  numInstances: 20,
  pointerParallax: 0.42,
  chromaticAberration: 0.0035,
  snapDelay: 220,
  snapDuration: 1.05,
};

const IMAGE_PATHS = [
  "1.png",
  "2.png",
  "3.png",
  "4.png",
  "5.png",
  "6.png",
  "1.png",
  "2.png",
  "3.png",
  "4.png",
  "5.png",
  "6.png",
  "1.png",
  "2.png",
  "3.png",
  "4.png",
  "5.png",
  "6.png",
  "1.png",
  "2.png",
];

// --- SHADERS ---
const vertexShader = `
    uniform float uRadius;
    uniform float uScrollOffset;
    uniform float uTotalHeight;
    uniform float uScale;
    uniform float uCurvature;
    uniform float uRotation;
    uniform float uSqueezeAmount;
    uniform float uSqueezeWidth;
    uniform float uVelocity;
    uniform float uTime;
    
    attribute float aAngleOffset;
    attribute float aPositionY;
    attribute float aTextureIndex;
    attribute vec2 aInstanceScale;

    varying vec2 vUv;
    varying float vTextureIndex;
    varying float vWorldY;
    varying float vFacing;

    void main() {
        vUv = uv;
        vTextureIndex = aTextureIndex;

        vec3 scaled = position;
        scaled.xy *= aInstanceScale;
        scaled *= uScale; 
        float scrolledY = aPositionY + uScrollOffset;
        scrolledY = mod(scrolledY + uTotalHeight * 0.5, uTotalHeight) - uTotalHeight * 0.5;
        float y = scrolledY + scaled.y;

        float squeezeGauss = exp(-(y * y) / (uSqueezeWidth * uSqueezeWidth));
        float squeezedRadius = uRadius * (1.0 - uSqueezeAmount * squeezeGauss);

        float motionFlex = scaled.y * uVelocity * 0.018;
        float breathing = sin(uTime * 0.55 + aAngleOffset * 1.7) * 0.025;
        float angle = aAngleOffset + uRotation + motionFlex;
        float theta = scaled.x / (squeezedRadius * uCurvature);
        float finalAngle = angle + theta;

        float animatedRadius = squeezedRadius + breathing;
        float x = sin(finalAngle) * animatedRadius;
        float z = cos(finalAngle) * animatedRadius;

        vWorldY = y;
        vFacing = smoothstep(-0.45, 0.75, cos(finalAngle));
        gl_Position = projectionMatrix * modelViewMatrix * vec4(x, y, z, 1.0);
    }
`;

const fragmentShader = `
    uniform sampler2D uAtlas;
    uniform float uAtlasCols;
    uniform float uAtlasRows;
    uniform float uTime;
    uniform float uVelocity;
    uniform float uChromaticAberration;

    varying vec2 vUv;
    varying float vTextureIndex;
    varying float vWorldY;
    varying float vFacing;

    vec2 getTileUV(vec2 sourceUV) {
        float idx = floor(vTextureIndex + 0.5);
        float col = mod(idx, uAtlasCols);
        float row = floor(idx / uAtlasCols);
        vec2 localUV = clamp(sourceUV, 0.006, 0.994);
        float tileU = (col + localUV.x) / uAtlasCols;
        float tileV = 1.0 - (row + 1.0 - localUV.y) / uAtlasRows;
        return vec2(tileU, tileV);
    }

    float roundedRectangle(vec2 uv, float radius) {
        vec2 q = abs(uv - 0.5) - vec2(0.5 - radius);
        float distanceToEdge = length(max(q, 0.0)) +
            min(max(q.x, q.y), 0.0) - radius;
        return 1.0 - smoothstep(-0.008, 0.008, distanceToEdge);
    }

    void main() {
        vec4 centerSample = texture2D(uAtlas, getTileUV(vUv));
        vec3 color = centerSample.rgb;

        float verticalFade = 1.0 - smoothstep(3.2, 7.7, abs(vWorldY));
        float facingFade = mix(0.25, 1.0, vFacing);
        float roundedMask = roundedRectangle(vUv, 0.045);

        float alpha = centerSample.a * verticalFade * facingFade * roundedMask;
        gl_FragColor = vec4(color, alpha);
    }
`;

// --- CORE CLASS ---
class Gallery {
  constructor() {
    this.container = document.getElementById("canvas-container");
    this.loader = document.getElementById("loader");
    this.loaderProgress = document.getElementById("loader-progress");
    this.focusOverlay = document.getElementById("focus-overlay");
    this.focusImage = document.getElementById("focus-image");

    // Scene setup
    this.scene = new THREE.Scene();
    this.scene.background = null;
    this.scene.fog = new THREE.Fog(0xe9e5dc, 9, 24);

    // Camera setup
    this.camera = new THREE.PerspectiveCamera(
      75,
      window.innerWidth / window.innerHeight,
      0.1,
      1000,
    );
    this.camera.position.z = 12;

    // Renderer
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: true,
      powerPreference: "high-performance",
    });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.toneMappingExposure = 1;
    this.container.appendChild(this.renderer.domElement);

    // State
    this.scrollOffset = 0;
    this.scrollVelocity = 0;
    this.pendingDelta = 0;
    this.lastTouchX = 0;
    this.isDragging = false;
    this.rotation = 0;
    this.rotationSpeed = 0.001;
    this.lastScrollDirection = 1;
    this.smoothSqueeze = 0;
    this.baseHeight = 2.7;
    this.hoveredInstance = -1;
    this.focusedInstance = -1;
    this.dragDistance = 0;
    this.pointerDown = new THREE.Vector2();
    this.lastTouchY = 0;
    this.focusTimeline = null;
    this.isFocusAnimating = false;
    this.snapTween = null;
    this.snapDelayCall = null;
    this.isSnapping = false;
    this.hasSnapped = false;
    this.hasUserInteracted = false;
    this.lastInteractionTime = performance.now();
    this.pointer = new THREE.Vector2(0, 0);
    this.smoothPointer = new THREE.Vector2(0, 0);
    this.reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    this.init();
  }

  async init() {
    this.setupLenis();
    await this.loadAtlas();
    this.createMesh();
    this.setupEvents();
    this.loader.classList.add("is-hidden");
    this.animate(0);
  }

  setupLenis() {
    this.lenis = new Lenis({
      duration: 1.15,
      easing: (value) => Math.min(1, 1.001 - Math.pow(2, -10 * value)),
      smoothWheel: true,
      wheelMultiplier: 0.82,
      touchMultiplier: 1.05,
      infinite: true,
      autoRaf: false,
    });

    this.lenis.on("scroll", (e) => {
      if (this.isSnapping || this.hasSnapped) return;
      // Use a slightly smaller multiplier for Lenis scroll vs manual drag
      this.pendingDelta += e.velocity * 0.005;
    });

    this.lenisTicker = (tickerTime) => {
      this.lenis.raf(tickerTime * 1000);
    };
    gsap.ticker.add(this.lenisTicker);
    gsap.ticker.lagSmoothing(0);
  }

  async loadAtlas() {
    const uniquePaths = Array.from(new Set(IMAGE_PATHS));
    const loader = new THREE.TextureLoader();
    let loadedCount = 0;

    // Load textures and keep track of their original image dimensions
    const textureData = await Promise.all(
      uniquePaths.map((p) => {
        return new Promise((resolve, reject) => {
          loader.load(p, (tex) => {
            const aspect = tex.image.width / tex.image.height;
            loadedCount += 1;
            this.loaderProgress.style.width =
              `${(loadedCount / uniquePaths.length) * 100}%`;
            resolve({ tex, aspect });
          }, undefined, reject);
        });
      }),
    );
    this.preloadedImages = textureData.map((data) => data.tex.image);

    const count = uniquePaths.length;
    const cols = Math.ceil(Math.sqrt(count));
    const rows = Math.ceil(count / cols);

    const canvas = document.createElement("canvas");
    canvas.width = 2048;
    canvas.height = 2048;
    const ctx = canvas.getContext("2d");

    const tileW = canvas.width / cols;
    const tileH = canvas.height / rows;

    this.aspectRatiosMap = []; // To store aspect ratios for unique images

    textureData.forEach((data, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      // Draw into atlas (stretching to square is fine, shader fixes it)
      ctx.drawImage(data.tex.image, col * tileW, row * tileH, tileW, tileH);
      this.aspectRatiosMap[i] = data.aspect;
    });

    this.atlasTexture = new THREE.CanvasTexture(canvas);
    this.atlasTexture.colorSpace = THREE.SRGBColorSpace;
    this.atlasTexture.minFilter = THREE.LinearMipmapLinearFilter;
    this.atlasTexture.magFilter = THREE.LinearFilter;
    this.atlasTexture.anisotropy =
      this.renderer.capabilities.getMaxAnisotropy();
    this.atlasCols = cols;
    this.atlasRows = rows;

    // Map the actual instances to their aspect ratios
    this.instanceAspects = IMAGE_PATHS.map((p) => {
      const uniqueIdx = uniquePaths.indexOf(p);
      return this.aspectRatiosMap[uniqueIdx];
    });

    this.indexMap = IMAGE_PATHS.map((p) => uniquePaths.indexOf(p));
  }

  createMesh() {
    // Start with a unit-sized plane (1x1) so our instanceScale is easy to calculate
    const geometry = new THREE.PlaneGeometry(1, 1, 40, 20);

    const angleOffsets = new Float32Array(CONFIG.numInstances);
    const positionYs = new Float32Array(CONFIG.numInstances);
    const textureIndices = new Float32Array(CONFIG.numInstances);
    const instanceScales = new Float32Array(CONFIG.numInstances * 2); // vec2

    const totalHeight = CONFIG.numInstances * CONFIG.spiralStep;
    const startY = -(totalHeight / 2);

    for (let i = 0; i < CONFIG.numInstances; i++) {
      angleOffsets[i] = i * ((Math.PI * 2) / CONFIG.imagesPerTurn);
      positionYs[i] = startY + i * CONFIG.spiralStep;
      textureIndices[i] = this.indexMap[i] || 0;

      // Calculate width based on aspect ratio
      const aspect = this.instanceAspects[i] || 1;
      instanceScales[i * 2] = this.baseHeight * aspect; // Width
      instanceScales[i * 2 + 1] = this.baseHeight; // Height
    }

    const instancedGeo = new THREE.InstancedBufferGeometry().copy(geometry);
    instancedGeo.setAttribute(
      "aAngleOffset",
      new THREE.InstancedBufferAttribute(angleOffsets, 1),
    );
    instancedGeo.setAttribute(
      "aPositionY",
      new THREE.InstancedBufferAttribute(positionYs, 1),
    );
    instancedGeo.setAttribute(
      "aTextureIndex",
      new THREE.InstancedBufferAttribute(textureIndices, 1),
    );
    instancedGeo.setAttribute(
      "aInstanceScale",
      new THREE.InstancedBufferAttribute(instanceScales, 2),
    );

    this.uniforms = {
      uRadius: { value: CONFIG.radius },
      uScrollOffset: { value: 0 },
      uTotalHeight: { value: totalHeight },
      uScale: { value: CONFIG.imageScale },
      uCurvature: { value: CONFIG.curvature },
      uRotation: { value: 0 },
      uSqueezeAmount: { value: 0 },
      uSqueezeWidth: { value: CONFIG.squeezeWidth },
      uVelocity: { value: 0 },
      uTime: { value: 0 },
      uChromaticAberration: { value: CONFIG.chromaticAberration },
      uAtlas: { value: this.atlasTexture },
      uAtlasCols: { value: this.atlasCols },
      uAtlasRows: { value: this.atlasRows },
    };

    const material = new THREE.ShaderMaterial({
      vertexShader,
      fragmentShader,
      uniforms: this.uniforms,
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: true,
      alphaTest: 0.015,
      toneMapped: false,
    });

    this.mesh = new THREE.InstancedMesh(
      instancedGeo,
      material,
      CONFIG.numInstances,
    );
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }
  updateSpiralLayout() {
    const angleOffsets = this.mesh.geometry.getAttribute("aAngleOffset");
    const positionYs = this.mesh.geometry.getAttribute("aPositionY");
    const totalHeight = CONFIG.numInstances * CONFIG.spiralStep;
    const startY = -(totalHeight / 2);

    for (let i = 0; i < CONFIG.numInstances; i++) {
      angleOffsets.array[i] = i * ((Math.PI * 2) / CONFIG.imagesPerTurn);
      positionYs.array[i] = startY + i * CONFIG.spiralStep;
    }

    angleOffsets.needsUpdate = true;
    positionYs.needsUpdate = true;
    this.uniforms.uTotalHeight.value = totalHeight;
  }

  setupEvents() {
    window.addEventListener("pointermove", (e) => {
      this.pointer.x = (e.clientX / window.innerWidth) * 2 - 1;
      this.pointer.y = (e.clientY / window.innerHeight) * 2 - 1;
    });

    window.addEventListener(
      "wheel",
      () => {
        if (this.focusedInstance !== -1) return;
        this.markInteraction();
        this.scheduleSnap();
      },
      { passive: true },
    );

    // Mouse Drag
    window.addEventListener("mousedown", (e) => {
      if (this.focusedInstance !== -1) return;
      this.markInteraction();
      this.isDragging = true;
      this.lastTouchX = e.clientX;
      this.lastTouchY = e.clientY;
      this.dragDistance = 0;
      this.pointerDown.set(e.clientX, e.clientY);
    });

    window.addEventListener("mousemove", (e) => {
      if (!this.isDragging) return;
      const deltaX = e.clientX - this.lastTouchX;
      const deltaY = e.clientY - this.lastTouchY;
      this.pendingDelta += deltaX * 0.005; // Matches the "heavy" feel we set
      this.lastInteractionTime = performance.now();
      this.dragDistance += Math.hypot(deltaX, deltaY);
      this.lastTouchX = e.clientX;
      this.lastTouchY = e.clientY;
    });

    window.addEventListener("mouseup", (e) => {
      if (this.isDragging && this.dragDistance < 8) {
        this.openImageAt(e.clientX, e.clientY);
      }
      this.isDragging = false;
      this.scheduleSnap();
    });

    // Mobile Touch Support
    window.addEventListener(
      "touchstart",
      (e) => {
        if (this.focusedInstance !== -1) return;
        this.markInteraction();
        this.isDragging = true; // Use dragging state for touch too
        this.lastTouchX = e.touches[0].clientX;
        this.lastTouchY = e.touches[0].clientY;
        this.dragDistance = 0;
        this.scrollVelocity = 0; // Reset velocity on fresh touch for control
      },
      { passive: false },
    );

    window.addEventListener(
      "touchmove",
      (e) => {
        if (!this.isDragging) return;

        const currentX = e.touches[0].clientX;
        const currentY = e.touches[0].clientY;
        // Corrected Math: Current - Last to match the "Drag Left = Move Left" logic
        const deltaX = currentX - this.lastTouchX;

        // We increase the multiplier slightly for mobile (0.008)
        // because fingers move across shorter physical distances than mice
        this.pendingDelta += deltaX * 0.008;
        this.lastInteractionTime = performance.now();
        this.dragDistance += Math.hypot(
          currentX - this.lastTouchX,
          currentY - this.lastTouchY,
        );

        this.lastTouchX = currentX;
        this.lastTouchY = currentY;

        // Prevent the browser from bouncing/refreshing
        if (e.cancelable) e.preventDefault();
      },
      { passive: false },
    );

    window.addEventListener("touchend", () => {
      if (this.isDragging && this.dragDistance < 10) {
        this.openImageAt(this.lastTouchX, this.lastTouchY);
      }
      this.isDragging = false;
      this.scheduleSnap();
    });

    window.addEventListener("resize", () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
      this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    });

    this.focusOverlay.addEventListener("click", () => {
      this.closeFocusedImage();
    });

    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.closeFocusedImage();
    });
  }

  markInteraction() {
    this.hasUserInteracted = true;
    this.hasSnapped = false;
    this.lastInteractionTime = performance.now();
    if (this.focusedInstance === -1) this.lenis?.start();

    if (this.snapTween) {
      this.snapTween.kill();
      this.snapTween = null;
    }
    if (this.snapDelayCall) {
      this.snapDelayCall.kill();
      this.snapDelayCall = null;
    }
    this.isSnapping = false;
  }

  scheduleSnap() {
    if (!this.hasUserInteracted || this.focusedInstance !== -1) return;
    this.snapDelayCall?.kill();
    this.snapDelayCall = gsap.delayedCall(CONFIG.snapDelay / 1000, () => {
      this.snapDelayCall = null;
      this.snapToNearestCard();
    });
  }

  normalizeAngle(angle) {
    return Math.atan2(Math.sin(angle), Math.cos(angle));
  }

  snapToNearestCard() {
    if (
      this.isSnapping ||
      this.hasSnapped ||
      this.focusedInstance !== -1 ||
      !this.hasUserInteracted
    ) {
      return;
    }

    const totalHeight = CONFIG.numInstances * CONFIG.spiralStep;
    const startY = -totalHeight * 0.5;
    let nearestCard = null;

    for (let i = 0; i < CONFIG.numInstances; i++) {
      const positionY = startY + i * CONFIG.spiralStep;
      const centerY = this.wrapVerticalPosition(positionY);
      const angle =
        i * ((Math.PI * 2) / CONFIG.imagesPerTurn) + this.rotation;
      const normalizedAngle = this.normalizeAngle(angle);

      // Prefer cards already near the viewport center and facing the camera.
      const score =
        Math.abs(centerY) * 0.78 +
        Math.abs(normalizedAngle) * 1.35 +
        (Math.cos(normalizedAngle) < 0 ? 4 : 0);

      if (!nearestCard || score < nearestCard.score) {
        nearestCard = {
          instanceIndex: i,
          centerY,
          normalizedAngle,
          score,
        };
      }
    }

    if (!nearestCard) return;

    const targetRotation = this.rotation - nearestCard.normalizedAngle;
    const currentUniformOffset =
      this.scrollOffset * CONFIG.scrollAdvanceSpeed;
    const targetUniformOffset = currentUniformOffset - nearestCard.centerY;
    const targetScrollOffset =
      targetUniformOffset / CONFIG.scrollAdvanceSpeed;
    const snapState = {
      rotation: this.rotation,
      scrollOffset: this.scrollOffset,
    };

    this.isSnapping = true;
    this.hasSnapped = true;
    this.scrollVelocity = 0;
    this.pendingDelta = 0;
    this.rotationSpeed = 0;
    this.lenis?.stop();

    this.snapTween = gsap.to(snapState, {
      rotation: targetRotation,
      scrollOffset: targetScrollOffset,
      duration: this.reducedMotion ? 0.01 : CONFIG.snapDuration,
      ease: "expo.out",
      overwrite: true,
      onUpdate: () => {
        this.rotation = snapState.rotation;
        this.scrollOffset = snapState.scrollOffset;
      },
      onComplete: () => {
        this.rotation = targetRotation;
        this.scrollOffset = targetScrollOffset;
        this.rotationSpeed = 0;
        this.scrollVelocity = 0;
        this.isSnapping = false;
        this.snapTween = null;
      },
    });
  }

  wrapVerticalPosition(positionY) {
    const totalHeight = this.uniforms.uTotalHeight.value;
    const movedY = positionY + this.uniforms.uScrollOffset.value;
    return (
      THREE.MathUtils.euclideanModulo(
        movedY + totalHeight * 0.5,
        totalHeight,
      ) -
      totalHeight * 0.5
    );
  }

  projectPoint(x, y, z) {
    const projected = new THREE.Vector3(x, y, z).project(this.camera);
    return {
      x: (projected.x * 0.5 + 0.5) * window.innerWidth,
      y: (-projected.y * 0.5 + 0.5) * window.innerHeight,
      z: projected.z,
    };
  }

  getProjectedCard(instanceIndex) {
    const totalHeight = CONFIG.numInstances * CONFIG.spiralStep;
    const startY = -totalHeight * 0.5;
    const positionY = startY + instanceIndex * CONFIG.spiralStep;
    const centerY = this.wrapVerticalPosition(positionY);
    const baseAngle =
      instanceIndex * ((Math.PI * 2) / CONFIG.imagesPerTurn) + this.rotation;

    if (Math.cos(baseAngle) < -0.18 || Math.abs(centerY) > 7.6) return null;

    const squeezeGauss = Math.exp(
      -(centerY * centerY) / (CONFIG.squeezeWidth * CONFIG.squeezeWidth),
    );
    const radius =
      CONFIG.radius * (1 - this.smoothSqueeze * squeezeGauss);
    const aspect = this.instanceAspects[instanceIndex] || 1;
    const halfWidth = this.baseHeight * aspect * CONFIG.imageScale * 0.5;
    const halfHeight = this.baseHeight * CONFIG.imageScale * 0.5;
    const corners = [];

    for (const localY of [-halfHeight, halfHeight]) {
      for (const localX of [-halfWidth, halfWidth]) {
        const angle =
          baseAngle + localX / (radius * CONFIG.curvature);
        corners.push(
          this.projectPoint(
            Math.sin(angle) * radius,
            centerY + localY,
            Math.cos(angle) * radius,
          ),
        );
      }
    }

    const xValues = corners.map((point) => point.x);
    const yValues = corners.map((point) => point.y);
    const center = this.projectPoint(
      Math.sin(baseAngle) * radius,
      centerY,
      Math.cos(baseAngle) * radius,
    );

    return {
      instanceIndex,
      left: Math.min(...xValues),
      right: Math.max(...xValues),
      top: Math.min(...yValues),
      bottom: Math.max(...yValues),
      center,
      depth: Math.cos(baseAngle),
    };
  }

  findCardAt(clientX, clientY) {
    const candidates = [];

    for (let i = 0; i < CONFIG.numInstances; i++) {
      const card = this.getProjectedCard(i);
      if (!card) continue;
      const padding = 8;
      const inside =
        clientX >= card.left - padding &&
        clientX <= card.right + padding &&
        clientY >= card.top - padding &&
        clientY <= card.bottom + padding;
      if (inside) candidates.push(card);
    }

    candidates.sort((a, b) => b.depth - a.depth);
    return candidates[0] || null;
  }

  shiftColorHue(rgbColor, degreeShift) {
    let [red, green, blue] = rgbColor.map((value) => value / 255);
    const maximum = Math.max(red, green, blue);
    const minimum = Math.min(red, green, blue);
    const lightness = (maximum + minimum) / 2;
    const difference = maximum - minimum;
    let hue = 0;
    let saturation = 0;

    if (difference !== 0) {
      saturation =
        lightness > 0.5
          ? difference / (2 - maximum - minimum)
          : difference / (maximum + minimum);

      if (maximum === red) {
        hue = (green - blue) / difference + (green < blue ? 6 : 0);
      } else if (maximum === green) {
        hue = (blue - red) / difference + 2;
      } else {
        hue = (red - green) / difference + 4;
      }
      hue /= 6;
    }

    hue = (hue + degreeShift / 360 + 1) % 1;
    saturation = Math.max(saturation, 0.58);
    const adjustedLightness = THREE.MathUtils.clamp(lightness, 0.38, 0.62);

    const hueToRgb = (p, q, channel) => {
      let adjustedChannel = channel;
      if (adjustedChannel < 0) adjustedChannel += 1;
      if (adjustedChannel > 1) adjustedChannel -= 1;
      if (adjustedChannel < 1 / 6) return p + (q - p) * 6 * adjustedChannel;
      if (adjustedChannel < 1 / 2) return q;
      if (adjustedChannel < 2 / 3) {
        return p + (q - p) * (2 / 3 - adjustedChannel) * 6;
      }
      return p;
    };

    const q =
      adjustedLightness < 0.5
        ? adjustedLightness * (1 + saturation)
        : adjustedLightness + saturation - adjustedLightness * saturation;
    const p = 2 * adjustedLightness - q;

    red = hueToRgb(p, q, hue + 1 / 3);
    green = hueToRgb(p, q, hue);
    blue = hueToRgb(p, q, hue - 1 / 3);

    return [red, green, blue].map((value) => Math.round(value * 255));
  }

  extractFocusColors(imageElement) {
    const sampleCanvas = document.createElement("canvas");
    sampleCanvas.width = 36;
    sampleCanvas.height = 36;
    const sampleContext = sampleCanvas.getContext("2d", {
      willReadFrequently: true,
    });
    sampleContext.drawImage(
      imageElement,
      0,
      0,
      sampleCanvas.width,
      sampleCanvas.height,
    );
    const pixels = sampleContext.getImageData(
      0,
      0,
      sampleCanvas.width,
      sampleCanvas.height,
    ).data;
    const colorfulPixels = [];

    for (let i = 0; i < pixels.length; i += 4) {
      const red = pixels[i];
      const green = pixels[i + 1];
      const blue = pixels[i + 2];
      const maximum = Math.max(red, green, blue);
      const minimum = Math.min(red, green, blue);
      const saturation = maximum - minimum;
      const brightness = (red + green + blue) / 3;

      if (saturation > 34 && brightness > 34 && brightness < 232) {
        colorfulPixels.push({ red, green, blue, saturation });
      }
    }

    colorfulPixels.sort((a, b) => b.saturation - a.saturation);
    const selectedPixels = colorfulPixels.slice(
      0,
      Math.max(12, Math.floor(colorfulPixels.length * 0.28)),
    );

    const averageRange = (startRatio, endRatio) => {
      const start = Math.floor(selectedPixels.length * startRatio);
      const end = Math.max(start + 1, Math.floor(selectedPixels.length * endRatio));
      const range = selectedPixels.slice(start, end);
      const total = range.reduce(
        (result, pixel) => {
          result.red += pixel.red;
          result.green += pixel.green;
          result.blue += pixel.blue;
          return result;
        },
        { red: 0, green: 0, blue: 0 },
      );
      const count = Math.max(range.length, 1);
      return [
        Math.round(total.red / count),
        Math.round(total.green / count),
        Math.round(total.blue / count),
      ];
    };

    if (selectedPixels.length < 2) {
      return {
        primary: [210, 74, 112],
        secondary: [84, 68, 180],
      };
    }

    const primary = averageRange(0, 0.48);
    let secondary = averageRange(0.52, 1);
    const colorDistance = Math.hypot(
      primary[0] - secondary[0],
      primary[1] - secondary[1],
      primary[2] - secondary[2],
    );

    if (colorDistance < 78) {
      secondary = this.shiftColorHue(primary, 112);
    }

    return { primary, secondary };
  }

  createTransitionProxy(imagePath, rectangle) {
    const proxyImage = document.createElement("img");
    proxyImage.className = "focus-transition-proxy";
    proxyImage.src = imagePath;
    Object.assign(proxyImage.style, {
      left: `${rectangle.left}px`,
      top: `${rectangle.top}px`,
      width: `${Math.max(rectangle.width ?? rectangle.right - rectangle.left, 1)}px`,
      height: `${Math.max(rectangle.height ?? rectangle.bottom - rectangle.top, 1)}px`,
    });
    document.body.appendChild(proxyImage);
    return proxyImage;
  }

  openImageAt(clientX, clientY) {
    if (this.focusedInstance !== -1 || this.isFocusAnimating) return;
    const card = this.findCardAt(clientX, clientY);
    if (!card) return;

    this.focusedInstance = card.instanceIndex;
    this.isFocusAnimating = true;
    this.scrollVelocity = 0;
    this.pendingDelta = 0;
    this.lenis?.stop();
    const preloadedImage =
      this.preloadedImages[this.indexMap[card.instanceIndex]];
    this.focusImage.src =
      preloadedImage?.currentSrc || preloadedImage?.src || IMAGE_PATHS[card.instanceIndex];

    const animateIntoFocus = () => {
      const sourceRectangle = {
        left: card.left,
        top: card.top,
        width: Math.max(card.right - card.left, 1),
        height: Math.max(card.bottom - card.top, 1),
      };
      const proxyImage = this.createTransitionProxy(
        IMAGE_PATHS[card.instanceIndex],
        sourceRectangle,
      );
      const backgroundField = document.querySelector(".background-field");

      gsap.set(this.container, {
        filter: "blur(0px) saturate(1) brightness(1)",
        opacity: 1,
        scale: 1,
      });
      gsap.set(backgroundField, { scale: 1.01 });
      gsap.set(this.focusOverlay, { autoAlpha: 0 });
      gsap.set(this.focusImage, { opacity: 0, scale: 0.985 });

      this.focusOverlay.classList.add("is-active");
      this.focusOverlay.setAttribute("aria-hidden", "false");
      document.body.classList.add("is-focused");

      requestAnimationFrame(() => {
        const fitVariables = Flip.fit(proxyImage, this.focusImage, {
          scale: true,
          getVars: true,
        });

        this.focusTimeline?.kill();
        this.focusTimeline = gsap.timeline({
          onComplete: () => {
            proxyImage.remove();
            gsap.set(this.focusImage, {
              opacity: 1,
              scale: 1,
              clearProps: "filter",
            });
            this.isFocusAnimating = false;
          },
        });

        this.focusTimeline
          .to(
            proxyImage,
            {
              ...fitVariables,
              duration: this.reducedMotion ? 0.01 : 1.12,
              ease: "expo.inOut",
            },
            0,
          )
          .to(
            proxyImage,
            {
              borderRadius: 18,
              filter: "none",
              duration: this.reducedMotion ? 0.01 : 0.78,
              ease: "power2.out",
            },
            0.18,
          )
          .to(
            this.focusOverlay,
            {
              autoAlpha: 1,
              duration: this.reducedMotion ? 0.01 : 0.64,
              ease: "power2.out",
            },
            0,
          )
          .to(
            this.container,
            {
              filter: "blur(18px) saturate(0.62) brightness(0.96)",
              opacity: 0.3,
              scale: 1.04,
              duration: this.reducedMotion ? 0.01 : 0.94,
              ease: "power3.inOut",
            },
            0,
          )
          .to(
            backgroundField,
            {
              scale: 1.045,
              duration: this.reducedMotion ? 0.01 : 1.2,
              ease: "power3.inOut",
            },
            0,
          )
          .to(
            proxyImage,
            {
              opacity: 0,
              duration: this.reducedMotion ? 0.01 : 0.14,
              ease: "power1.out",
            },
            this.reducedMotion ? 0 : 0.98,
          )
          .to(
            this.focusImage,
            {
              opacity: 1,
              scale: 1,
              duration: this.reducedMotion ? 0.01 : 0.16,
              ease: "power1.out",
            },
            this.reducedMotion ? 0 : 0.96,
          );
      });
    };

    if (this.focusImage.complete) {
      requestAnimationFrame(animateIntoFocus);
    } else {
      this.focusImage.addEventListener("load", animateIntoFocus, {
        once: true,
      });
    }
  }

  closeFocusedImage() {
    if (this.focusedInstance === -1 || this.isFocusAnimating) return;

    this.isFocusAnimating = true;
    const focusedCard = this.getProjectedCard(this.focusedInstance);
    const current = this.focusImage.getBoundingClientRect();
    const backgroundField = document.querySelector(".background-field");
    const proxyImage = this.createTransitionProxy(
      IMAGE_PATHS[this.focusedInstance],
      current,
    );
    const destination = document.createElement("span");
    const destinationRectangle = focusedCard
      ? {
          left: focusedCard.left,
          top: focusedCard.top,
          width: Math.max(focusedCard.right - focusedCard.left, 1),
          height: Math.max(focusedCard.bottom - focusedCard.top, 1),
        }
      : {
          left: window.innerWidth * 0.5 - current.width * 0.15,
          top: window.innerHeight * 0.5 - current.height * 0.15,
          width: current.width * 0.3,
          height: current.height * 0.3,
        };

    Object.assign(destination.style, {
      position: "fixed",
      left: `${destinationRectangle.left}px`,
      top: `${destinationRectangle.top}px`,
      width: `${destinationRectangle.width}px`,
      height: `${destinationRectangle.height}px`,
      pointerEvents: "none",
      opacity: "0",
    });
    document.body.appendChild(destination);
    gsap.set(this.focusImage, { opacity: 0 });

    const fitVariables = Flip.fit(proxyImage, destination, {
      scale: true,
      getVars: true,
    });

    this.focusTimeline?.kill();
    this.focusTimeline = gsap.timeline({
      onComplete: () => {
        proxyImage.remove();
        destination.remove();
        this.focusOverlay.classList.remove("is-active");
        this.focusOverlay.setAttribute("aria-hidden", "true");
        document.body.classList.remove("is-focused");
        this.focusImage.removeAttribute("src");
        this.focusedInstance = -1;
        this.isFocusAnimating = false;
        this.lenis?.start();
        gsap.set(
          [
            this.focusOverlay,
            this.focusImage,
            this.container,
            backgroundField,
          ],
          { clearProps: "all" },
        );
      },
    });

    this.focusTimeline
      .to(
        proxyImage,
        {
          ...fitVariables,
          duration: this.reducedMotion ? 0.01 : 0.88,
          ease: "power3.inOut",
        },
        0,
      )
      .to(
        proxyImage,
        {
          borderRadius: 6,
          opacity: 0.82,
          duration: this.reducedMotion ? 0.01 : 0.7,
          ease: "power2.inOut",
        },
        0,
      )
      .to(
        this.container,
        {
          filter: "blur(0px) saturate(1) brightness(1)",
          opacity: 1,
          scale: 1,
          duration: this.reducedMotion ? 0.01 : 0.86,
          ease: "power3.inOut",
        },
        0,
      )
      .to(
        backgroundField,
        {
          scale: 1.01,
          duration: this.reducedMotion ? 0.01 : 0.9,
          ease: "power3.inOut",
        },
        0,
      )
      .to(
        this.focusOverlay,
        {
          autoAlpha: 0,
          duration: this.reducedMotion ? 0.01 : 0.6,
          ease: "power2.inOut",
        },
        0.22,
      )
      .to(
        proxyImage,
        {
          opacity: 0,
          duration: this.reducedMotion ? 0.01 : 0.12,
          ease: "power1.in",
        },
        this.reducedMotion ? 0 : 0.78,
      );
  }

  animate(time) {
    requestAnimationFrame((t) => this.animate(t));

    // Physics
    this.scrollVelocity += this.pendingDelta;
    this.pendingDelta = 0;
    this.scrollVelocity *= CONFIG.momentum;
    if (Math.abs(this.scrollVelocity) < 0.0001) this.scrollVelocity = 0;
    this.scrollOffset += this.scrollVelocity;

    // Uniforms update
    this.uniforms.uScrollOffset.value =
      this.scrollOffset * CONFIG.scrollAdvanceSpeed;

    //  This ensures the rotation follows the scroll direction smoothly
    if (Math.abs(this.scrollVelocity) > 0.0001) {
      this.lastScrollDirection = this.scrollVelocity > 0 ? 1 : -1;
    }

    // Check if we are actually scrolling to apply forces
    const targetSpeed =
      this.focusedInstance === -1 &&
      !this.isSnapping &&
      !this.hasSnapped
        ? CONFIG.autoRotateSpeed * this.lastScrollDirection +
          this.scrollVelocity * CONFIG.scrollRotateForce
        : 0;

    if (Math.abs(this.scrollVelocity) > 0.001) {
      this.lastScrollDirection = this.scrollVelocity > 0 ? 1 : -1;
    }

    // const targetSpeed = (CONFIG.autoRotateSpeed * this.lastScrollDirection) + (this.scrollVelocity * CONFIG.scrollRotateForce);
    const clampedSpeed = THREE.MathUtils.clamp(targetSpeed, -0.2, 0.2);

    this.rotationSpeed +=
      (clampedSpeed - this.rotationSpeed) * CONFIG.rotationSmoothing;
    this.rotation += this.rotationSpeed;
    this.uniforms.uRotation.value = this.rotation;
    this.uniforms.uVelocity.value = this.scrollVelocity;
    this.uniforms.uTime.value = time * 0.001;

    const targetSqueeze =
      Math.min(Math.abs(this.scrollVelocity) * 3, 1.0) *
      CONFIG.squeezeIntensity;
    this.smoothSqueeze += (targetSqueeze - this.smoothSqueeze) * 0.08;
    this.uniforms.uSqueezeAmount.value = this.smoothSqueeze;

    const hasSettled =
      !this.isDragging &&
      !this.isSnapping &&
      Math.abs(this.scrollVelocity) < 0.0015 &&
      Math.abs(this.pendingDelta) < 0.0015 &&
      time - this.lastInteractionTime > CONFIG.snapDelay;

    if (hasSettled) this.snapToNearestCard();

    const parallaxStrength = this.reducedMotion ? 0 : CONFIG.pointerParallax;
    this.smoothPointer.lerp(this.pointer, 0.045);
    this.camera.position.x = this.smoothPointer.x * parallaxStrength;
    this.camera.position.y = -this.smoothPointer.y * parallaxStrength * 0.55;
    this.camera.lookAt(0, 0, 0);

    if (!this.isDragging && this.focusedInstance === -1) {
      const pointerX = (this.pointer.x * 0.5 + 0.5) * window.innerWidth;
      const pointerY = (-this.pointer.y * 0.5 + 0.5) * window.innerHeight;
      const hoveredCard = this.findCardAt(pointerX, pointerY);
      this.hoveredInstance = hoveredCard?.instanceIndex ?? -1;
      this.container.classList.toggle(
        "is-hovering",
        this.hoveredInstance !== -1,
      );
    }

    this.renderer.render(this.scene, this.camera);
  }
}

window.gallery = new Gallery();
