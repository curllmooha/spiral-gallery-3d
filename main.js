import * as THREE from "three";
import GUI from "lil-gui";

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
};

const IMAGE_PATHS = [
  "images/1.png",
  "images/2.png",
  "images/3.png",
  "images/4.png",
  "images/5.png",
  "images/6.png",
  "images/1.png",
  "images/2.png",
  "images/3.png",
  "images/4.png",
  "images/5.png",
  "images/6.png",
  "images/1.png",
  "images/2.png",
  "images/3.png",
  "images/4.png",
  "images/5.png",
  "images/6.png",
  "images/1.png",
  "images/2.png",
  "images/3.png",
  "images/4.png",
  "images/5.png",
  "images/6.png",
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
    
    attribute float aAngleOffset;
    attribute float aPositionY;
    attribute float aTextureIndex;
    attribute vec2 aInstanceScale;

    varying vec2 vUv;
    varying float vTextureIndex;
    varying float vWorldY;

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

        float angle = aAngleOffset + uRotation;
        float theta = scaled.x / (squeezedRadius * uCurvature);
        float finalAngle = angle + theta;

        float x = sin(finalAngle) * squeezedRadius;
        float z = cos(finalAngle) * squeezedRadius;

        vWorldY = y;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(x, y, z, 1.0);
    }
`;

const fragmentShader = `
    uniform sampler2D uAtlas;
    uniform float uAtlasCols;
    uniform float uAtlasRows;

    varying vec2 vUv;
    varying float vTextureIndex;
    varying float vWorldY;

    vec2 getTileUV(vec2 localUV) {
        float idx = floor(vTextureIndex + 0.5);
        float col = mod(idx, uAtlasCols);
        float row = floor(idx / uAtlasCols);
        float tileU = (col + localUV.x) / uAtlasCols;
        float tileV = 1.0 - (row + 1.0 - localUV.y) / uAtlasRows;
        return vec2(tileU, tileV);
    }

    void main() {
        vec2 tileUV = getTileUV(vUv);
        vec4 texColor = texture2D(uAtlas, tileUV);
        float fade = 1.0 - smoothstep(3.0, 7.5, abs(vWorldY));
        gl_FragColor = vec4(texColor.rgb, texColor.a * fade);
    }
`;

// --- CORE CLASS ---
class Gallery {
  constructor() {
    this.container = document.getElementById("canvas-container");

    // Scene setup
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0xe5e4e2);
    this.scene.fog = new THREE.Fog(0xe5e4e2, 8, 25);

    // Camera setup
    this.camera = new THREE.PerspectiveCamera(
      75,
      window.innerWidth / window.innerHeight,
      0.1,
      1000,
    );
    this.camera.position.z = 12;

    // Renderer
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.setPixelRatio(window.devicePixelRatio);
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

    this.init();
  }

  async init() {
    this.setupLenis();
    await this.loadAtlas();
    this.createMesh();
    this.setupGUI();
    this.setupEvents();
    this.animate(0);
  }

  setupLenis() {
    this.lenis = new Lenis({
      lerp: 0.05,
      smoothWheel: true,
      infinite: true,
    });

    this.lenis.on("scroll", (e) => {
      // Use a slightly smaller multiplier for Lenis scroll vs manual drag
      this.pendingDelta += e.velocity * 0.005;
    });
  }

  async loadAtlas() {
    const uniquePaths = Array.from(new Set(IMAGE_PATHS));
    const loader = new THREE.TextureLoader();

    // Load textures and keep track of their original image dimensions
    const textureData = await Promise.all(
      uniquePaths.map((p) => {
        return new Promise((resolve) => {
          loader.load(p, (tex) => {
            const aspect = tex.image.width / tex.image.height;
            resolve({ tex, aspect });
          });
        });
      }),
    );

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
    this.atlasTexture.colorSpace = "srgb";
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

    const baseHeight = 2.7; // The standard height you want for all cards

    for (let i = 0; i < CONFIG.numInstances; i++) {
      angleOffsets[i] = i * ((Math.PI * 2) / CONFIG.imagesPerTurn);
      positionYs[i] = startY + i * CONFIG.spiralStep;
      textureIndices[i] = this.indexMap[i] || 0;

      // Calculate width based on aspect ratio
      const aspect = this.instanceAspects[i] || 1;
      instanceScales[i * 2] = baseHeight * aspect; // Width
      instanceScales[i * 2 + 1] = baseHeight; // Height
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
    });

    this.mesh = new THREE.InstancedMesh(
      instancedGeo,
      material,
      CONFIG.numInstances,
    );
    this.mesh.frustumCulled = false;
    this.scene.add(this.mesh);
  }
  setupGUI() {
    const gui = new GUI();
    const shape = gui.addFolder("Spiral Shape");
    shape
      .add(CONFIG, "radius", 1, 15)
      .onChange((v) => (this.uniforms.uRadius.value = v));
    shape
      .add(CONFIG, "spiralStep", 0.1, 5)
      .onChange(() => this.updateSpiralLayout());
    shape
      .add(CONFIG, "imagesPerTurn", 1, 20)
      .onChange(() => this.updateSpiralLayout());
    shape
      .add(CONFIG, "curvature", 0.1, 5)
      .onChange((v) => (this.uniforms.uCurvature.value = v));
    shape
      .add(CONFIG, "imageScale", 0.1, 2)
      .onChange((v) => (this.uniforms.uScale.value = v));

    const anim = gui.addFolder("Animation");
    anim.add(CONFIG, "autoRotateSpeed", 0, 0.05);
    anim.add(CONFIG, "scrollRotateForce", 0, 10);
    anim.add(CONFIG, "rotationSmoothing", 0.01, 0.5);
    anim.add(CONFIG, "momentum", 0.5, 0.99);
    anim.add(CONFIG, "scrollAdvanceSpeed", 0, 2);

    const squeeze = gui.addFolder("Squeeze Effect");
    squeeze.add(CONFIG, "squeezeIntensity", 0, 1);
    squeeze
      .add(CONFIG, "squeezeWidth", 1, 20)
      .onChange((v) => (this.uniforms.uSqueezeWidth.value = v));
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
    // Mouse Drag
    window.addEventListener("mousedown", (e) => {
      this.isDragging = true;
      this.lastTouchX = e.clientX;
    });

    window.addEventListener("mousemove", (e) => {
      if (!this.isDragging) return;
      const deltaX = e.clientX - this.lastTouchX;
      this.pendingDelta += deltaX * 0.005; // Matches the "heavy" feel we set
      this.lastTouchX = e.clientX;
    });

    window.addEventListener("mouseup", () => {
      this.isDragging = false;
    });

    // Mobile Touch Support
    window.addEventListener(
      "touchstart",
      (e) => {
        this.isDragging = true; // Use dragging state for touch too
        this.lastTouchX = e.touches[0].clientX;
        this.scrollVelocity = 0; // Reset velocity on fresh touch for control
      },
      { passive: false },
    );

    window.addEventListener(
      "touchmove",
      (e) => {
        if (!this.isDragging) return;

        const currentX = e.touches[0].clientX;
        // Corrected Math: Current - Last to match the "Drag Left = Move Left" logic
        const deltaX = currentX - this.lastTouchX;

        // We increase the multiplier slightly for mobile (0.008)
        // because fingers move across shorter physical distances than mice
        this.pendingDelta += deltaX * 0.008;

        this.lastTouchX = currentX;

        // Prevent the browser from bouncing/refreshing
        if (e.cancelable) e.preventDefault();
      },
      { passive: false },
    );

    window.addEventListener("touchend", () => {
      this.isDragging = false;
    });

    window.addEventListener("resize", () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    });
  }

  animate(time) {
    requestAnimationFrame((t) => this.animate(t));

    if (this.lenis) this.lenis.raf(time);

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
      CONFIG.autoRotateSpeed * this.lastScrollDirection +
      this.scrollVelocity * CONFIG.scrollRotateForce;

    if (Math.abs(this.scrollVelocity) > 0.001) {
      this.lastScrollDirection = this.scrollVelocity > 0 ? 1 : -1;
    }

    // const targetSpeed = (CONFIG.autoRotateSpeed * this.lastScrollDirection) + (this.scrollVelocity * CONFIG.scrollRotateForce);
    const clampedSpeed = THREE.MathUtils.clamp(targetSpeed, -0.2, 0.2);

    this.rotationSpeed +=
      (clampedSpeed - this.rotationSpeed) * CONFIG.rotationSmoothing;
    this.rotation += this.rotationSpeed;
    this.uniforms.uRotation.value = this.rotation;

    const targetSqueeze =
      Math.min(Math.abs(this.scrollVelocity) * 3, 1.0) *
      CONFIG.squeezeIntensity;
    this.smoothSqueeze += (targetSqueeze - this.smoothSqueeze) * 0.08;
    this.uniforms.uSqueezeAmount.value = this.smoothSqueeze;

    this.renderer.render(this.scene, this.camera);
  }
}

new Gallery();
