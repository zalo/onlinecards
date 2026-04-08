/* eslint-env browser */
/* global PARTYKIT_HOST */

// @ts-check
import * as THREE from 'three/webgpu';
import { pass, mrt, output, normalView, diffuseColor, velocity, add, vec4, directionToColor, colorToDirection, sample } from 'three/tsl';
import { ssgi } from 'three/addons/tsl/display/SSGINode.js';
import { traa } from 'three/addons/tsl/display/TRAANode.js';
import PartySocket from "partysocket";
import "./styles.css";

// ── Constants ───────────────────────────────────────────────────────
const HAND_Z = 1.0;

// ── Main class ──────────────────────────────────────────────────────

class CardGame3D {
  constructor() {
    this.queryParams = new URLSearchParams(window.location.search || window.location.hash.substr(1));
    if (this.queryParams.has("room")) {
      this.curRoom = this.queryParams.get('room') || "global";
    } else {
      this.curRoom = "global";
      this.queryParams.set("room", this.curRoom);
      window.history.replaceState({}, "", `${window.location.pathname}?${this.queryParams.toString()}`);
    }

    /** @type {PartySocket} */
    this.conn = new PartySocket({
      // @ts-expect-error PARTYKIT_HOST is a global string injected by PartyKit
      host: PARTYKIT_HOST,
      room: this.curRoom,
    });

    // Game state
    /** @type {Record<string, any>} */
    this.cards = {};
    /** @type {Record<string, any>} */
    this.players = {};
    /** @type {Record<string, string>} */
    this.playersToColors = {};
    /** @type {string|null} */
    this.curDragging = null;
    /** @type {{x:number,z:number}|null} */
    this.selectionStart = null;
    this.lastDown = 0;
    this.previousDown = 0;

    this.setupScene();
    this.setupUI();

    this.conn.addEventListener("message", this.updateFromServer.bind(this));
    window.addEventListener("pointerdown", this.onPointerDown.bind(this));
    window.addEventListener("pointermove", this.onPointerMove.bind(this));
    window.addEventListener("pointerup",   this.onPointerUp  .bind(this));
    window.addEventListener("resize",      this.onResize      .bind(this));
  }

  // ── Three.js Scene Setup ──────────────────────────────────────────

  async setupScene() {
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x070d09);

    // Camera — overhead perspective looking at the table
    this.camera = new THREE.PerspectiveCamera(50, window.innerWidth / window.innerHeight, 0.1, 100);
    this.camera.position.set(0, 7.5, 5.5);
    this.camera.lookAt(0, 0, 0.5);

    let isMobile = /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent);
    let pixelRatio = isMobile ? Math.max(0.5, window.devicePixelRatio * 0.25) : Math.min(1, window.devicePixelRatio);

    // WebGPU Renderer (falls back to WebGL2 gracefully)
    this.renderer = new THREE.WebGPURenderer();
    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.shadowMap.enabled = true;
    document.body.appendChild(this.renderer.domElement);
    // Async init required before render pipeline setup
    await this.renderer.init();

    // ── Lighting ──
    // Warm overhead spotlight
    this.spotLight = new THREE.SpotLight(0xfff5e0, 30, 25, Math.PI / 3.5, 0.4, 1);
    this.spotLight.position.set(0, 10, 0);
    this.spotLight.castShadow = true;
    this.spotLight.shadow.mapSize.width = 2048;
    this.spotLight.shadow.mapSize.height = 2048;
    this.spotLight.shadow.camera.near = 1;
    this.spotLight.shadow.camera.far = 20;
    this.spotLight.shadow.bias = -0.0002;
    this.spotLight.shadow.normalBias = 0.02;
    this.scene.add(this.spotLight);

    // Hemisphere fill for ambient colour
    let hemi = new THREE.HemisphereLight(0xfff8e8, 0x1a3a20, 2.0);
    hemi.position.set(0, 20, 0);
    this.scene.add(hemi);

    // Subtle directional light for rim highlights
    let dir = new THREE.DirectionalLight(0xc8a84e, 1.5);
    dir.position.set(-4, 6, 3);
    this.scene.add(dir);

    // ── Post-processing: SSGI + TRAA ──
    this.renderPipeline = new THREE.RenderPipeline(this.renderer);

    const scenePass = pass(this.scene, this.camera);
    scenePass.setMRT(mrt({
      output: output,
      diffuseColor: diffuseColor,
      normal: directionToColor(normalView),
      velocity: velocity
    }));

    const scenePassColor    = scenePass.getTextureNode('output');
    const scenePassDiffuse  = scenePass.getTextureNode('diffuseColor');
    const scenePassDepth    = scenePass.getTextureNode('depth');
    const scenePassNormal   = scenePass.getTextureNode('normal');
    const scenePassVelocity = scenePass.getTextureNode('velocity');

    // Reduce bandwidth with lower-precision textures
    scenePass.getTexture('diffuseColor').type = THREE.UnsignedByteType;
    scenePass.getTexture('normal').type       = THREE.UnsignedByteType;

    const sceneNormal = sample(( /** @type {any} */ uv) => colorToDirection(scenePassNormal.sample(uv)));

    this.giPass = ssgi(scenePassColor, scenePassDepth, sceneNormal, this.camera);
    this.giPass.useTemporalFiltering = true;
    if (isMobile) {
      this.giPass.sliceCount.value = 1;
      this.giPass.stepCount.value  = 8;
    } else {
      this.giPass.sliceCount.value = 2;
      this.giPass.stepCount.value  = 8;
    }

    const gi = this.giPass.rgb;
    const ao = this.giPass.a;
    const compositePass = vec4(add(scenePassColor.rgb.mul(ao), scenePassDiffuse.rgb.mul(gi)), scenePassColor.a);
    const traaPass = traa(compositePass, scenePassDepth, scenePassVelocity, this.camera);
    this.renderPipeline.outputNode = traaPass;

    this.onResize();
    this.renderer.setAnimationLoop(this.animate.bind(this));

    // ── Table geometry ──
    this.buildTable();

    // ── Raycasting ──
    this.raycaster = new THREE.Raycaster();
    this.mouse = new THREE.Vector2();
    this.tablePlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    this.intersectPt = new THREE.Vector3();

    // ── Card/cursor state ──
    /** @type {Record<string, THREE.Mesh>} */
    this.cardMeshes = {};
    /** @type {Record<string, THREE.Mesh>} */
    this.cursorMeshes = {};
    /** @type {Record<string, THREE.Mesh>} */
    this.selectionMeshes = {};
    /** @type {Record<string, THREE.Mesh>} */
    this.highlightMeshes = {};

    this.textureLoader = new THREE.TextureLoader();
    /** @type {Record<string, THREE.Texture>} */
    this.texCache = {};

    this.backTex = this.textureLoader.load('./cards/BACK.jpg', (t) => {
      t.colorSpace = THREE.SRGBColorSpace;
    });

    this.cardGeom = new THREE.BoxGeometry(1.0, 0.02, 1.4);
    this.edgeMat = new THREE.MeshStandardMaterial({ color: 0xf5f0e8, roughness: 0.4, metalness: 0 });

    // Temp vectors for interpolation
    this._tv = new THREE.Vector3();
    this._tq = new THREE.Quaternion();
  }

  buildTable() {
    // Felt surface
    let feltMat = new THREE.MeshStandardMaterial({ color: 0x1a6b35, roughness: 0.92, metalness: 0 });
    let felt = new THREE.Mesh(new THREE.BoxGeometry(4.2, 0.1, 5.2), feltMat);
    felt.position.y = -0.05;
    felt.receiveShadow = true;
    this.scene.add(felt);

    // Wood rail
    let railMat = new THREE.MeshStandardMaterial({ color: 0x3d2415, roughness: 0.55, metalness: 0.1 });
    let rt = 0.18, rh = 0.1;
    let rails = [
      { pos: [-2.1 - rt / 2, rh / 2 - 0.05, 0],   size: [rt, rh, 5.2 + rt * 2] },
      { pos: [ 2.1 + rt / 2, rh / 2 - 0.05, 0],   size: [rt, rh, 5.2 + rt * 2] },
      { pos: [0, rh / 2 - 0.05, -2.6 - rt / 2],   size: [4.2, rh, rt] },
      { pos: [0, rh / 2 - 0.05,  2.6 + rt / 2],   size: [4.2, rh, rt] },
    ];
    for (let r of rails) {
      let m = new THREE.Mesh(new THREE.BoxGeometry(...r.size), railMat);
      m.position.set(...r.pos);
      m.castShadow = true;
      m.receiveShadow = true;
      this.scene.add(m);
    }

    // Hand area divider (subtle line)
    let divMat = new THREE.MeshBasicMaterial({ color: 0x5c3a24, transparent: true, opacity: 0.4 });
    let div = new THREE.Mesh(new THREE.PlaneGeometry(4.0, 0.03), divMat);
    div.rotation.x = -Math.PI / 2;
    div.position.set(0, 0.002, HAND_Z);
    this.scene.add(div);

    // Hand area — darker felt overlay
    let handMat = new THREE.MeshStandardMaterial({ color: 0x0e4422, roughness: 0.95, metalness: 0, transparent: true, opacity: 0.35 });
    let hand = new THREE.Mesh(new THREE.PlaneGeometry(4.0, 3.0), handMat);
    hand.rotation.x = -Math.PI / 2;
    hand.position.set(0, 0.001, HAND_Z + 1.5);
    this.scene.add(hand);
  }

  // ── Card mesh creation ────────────────────────────────────────────

  /** @param {string} suit @param {string} value */
  getCardTex(suit, value) {
    let key = `${suit}-${value}`;
    if (!this.texCache[key]) {
      this.texCache[key] = this.textureLoader.load(`./cards/${key}.svg`, (t) => {
        t.colorSpace = THREE.SRGBColorSpace;
      });
    }
    return this.texCache[key];
  }

  /** @param {string} cardId @param {string} suit @param {string} value */
  createCardMesh(cardId, suit, value) {
    let frontTex = this.getCardTex(suit, value);
    let frontMat = new THREE.MeshStandardMaterial({ map: frontTex, roughness: 0.3, metalness: 0 });
    let backMat  = new THREE.MeshStandardMaterial({ map: this.backTex, roughness: 0.3, metalness: 0 });

    // Box faces: +x, -x, +y (front), -y (back), +z, -z
    let materials = [this.edgeMat, this.edgeMat, frontMat, backMat, this.edgeMat, this.edgeMat];
    let mesh = new THREE.Mesh(this.cardGeom, materials);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.cardId = cardId;
    this.scene.add(mesh);
    this.cardMeshes[cardId] = mesh;
    return mesh;
  }

  /** @param {string} playerId @param {string} color */
  createCursorMesh(playerId, color) {
    let c = new THREE.Color(color);
    let mat = new THREE.MeshStandardMaterial({ color: c, emissive: c, emissiveIntensity: 0.6, roughness: 0.3 });
    let mesh = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.35, 8), mat);
    mesh.rotation.x = Math.PI; // point downward
    mesh.position.y = 0.25;
    mesh.castShadow = true;
    this.scene.add(mesh);
    this.cursorMeshes[playerId] = mesh;
    return mesh;
  }

  // ── UI Overlay ────────────────────────────────────────────────────

  setupUI() {
    let overlay = document.createElement('div');
    overlay.id = 'ui-overlay';
    document.body.appendChild(overlay);

    this.playerList = document.createElement('div');
    this.playerList.className = 'player-panel';
    overlay.appendChild(this.playerList);

    let btns = [
      { text: 'Deal',      cls: 'btn-deal',      msg: { type: "deal" } },
      { text: 'Reset',     cls: 'btn-reset',     msg: { type: "reset" } },
      { text: 'Sort Suit', cls: 'btn-sort-suit', msg: { type: "sortSuit" } },
      { text: 'Sort Rank', cls: 'btn-sort-rank', msg: { type: "sortRank" } },
    ];
    for (let b of btns) {
      let el = document.createElement('button');
      el.className = `game-btn ${b.cls}`;
      el.textContent = b.text;
      el.addEventListener('click', () => this.conn.send(JSON.stringify(b.msg)));
      overlay.appendChild(el);
    }
  }

  // ── Input → Table Raycasting ──────────────────────────────────────

  /** @param {PointerEvent} e @returns {{x:number,y:number,z:number}} */
  mouseToTable(e) {
    this.mouse.x =  (e.clientX / window.innerWidth)  * 2 - 1;
    this.mouse.y = -(e.clientY / window.innerHeight) * 2 + 1;
    this.raycaster.setFromCamera(this.mouse, this.camera);
    this.raycaster.ray.intersectPlane(this.tablePlane, this.intersectPt);
    return { x: this.intersectPt.x, y: 0, z: this.intersectPt.z };
  }

  /** @returns {string|null} */
  getCardAtMouse() {
    let visible = [];
    for (let id in this.cardMeshes) { if (this.cardMeshes[id].visible) visible.push(this.cardMeshes[id]); }
    let hits = this.raycaster.intersectObjects(visible);
    return hits.length > 0 ? /** @type {string} */ (hits[0].object.userData.cardId) : null;
  }

  // ── Pointer events ────────────────────────────────────────────────

  /** @param {PointerEvent} e */
  onPointerDown(e) {
    let pos = this.mouseToTable(e);
    this.conn.send(JSON.stringify({ type: "cursor", cursorPosition: pos, cursorPressed: true }));

    let cardId = this.getCardAtMouse();
    if (cardId) {
      // Double-tap → flip
      this.previousDown = this.lastDown;
      this.lastDown = performance.now();
      if (this.lastDown - this.previousDown < 300) {
        this.conn.send(JSON.stringify({ type: "cardFlip", card: cardId }));
      }
      // Deselect others if clicking unselected card
      if (this.cards[cardId] && this.cards[cardId].selectedBy !== this.conn.id) {
        this.conn.send(JSON.stringify({ type: "deselect" }));
      }
      this.conn.send(JSON.stringify({ type: "grab", card: cardId }));
      this.curDragging = cardId;
    } else {
      // Start box selection
      this.conn.send(JSON.stringify({ type: "deselect" }));
      this.selectionStart = { x: pos.x, z: pos.z };
    }
  }

  /** @param {PointerEvent} e */
  onPointerMove(e) {
    let pos = this.mouseToTable(e);
    this.conn.send(JSON.stringify({ type: "cursor", cursorPosition: pos, cursorPressed: e.buttons > 0 }));

    if (!this.curDragging && this.selectionStart && e.buttons > 0) {
      this.conn.send(JSON.stringify({ type: "selection", selection: {
        x1: Math.min(this.selectionStart.x, pos.x),
        z1: Math.min(this.selectionStart.z, pos.z),
        x2: Math.max(this.selectionStart.x, pos.x),
        z2: Math.max(this.selectionStart.z, pos.z),
      }}));
    }
  }

  /** @param {PointerEvent} e */
  onPointerUp(e) {
    let pos = this.mouseToTable(e);
    this.conn.send(JSON.stringify({ type: "cursor", cursorPosition: pos, cursorPressed: false }));

    if (this.curDragging) {
      this.conn.send(JSON.stringify({ type: "release" }));
      this.curDragging = null;
    } else if (this.selectionStart) {
      this.conn.send(JSON.stringify({ type: "endSelection" }));
      this.selectionStart = null;
    }
  }

  onResize() {
    let w = window.innerWidth, h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  // ── Animation loop ────────────────────────────────────────────────

  animate() {
    let alpha = 0.15;

    // Interpolate card meshes
    for (let id in this.cards) {
      let mesh = this.cardMeshes[id];
      if (!mesh) continue;
      let t = this.cards[id].position;
      let q = this.cards[id].quaternion;
      if (t && q) {
        this._tv.set(t.x, t.y, t.z);
        this._tq.set(q.x, q.y, q.z, q.w);
        mesh.position.lerp(this._tv, alpha);
        mesh.quaternion.slerp(this._tq, alpha);
      }
    }

    // Interpolate cursors
    for (let pid in this.players) {
      if (pid === this.conn.id) continue;
      let cur = this.cursorMeshes[pid];
      if (!cur) continue;
      let cp = this.players[pid].cursorPosition;
      if (cp) {
        this._tv.set(cp.x, 0.25, cp.z);
        cur.position.lerp(this._tv, alpha);
        cur.visible = cp.z < 2.0;
        cur.rotation.z = this.players[pid].cursorPressed ? 0.35 : 0;
      }
    }

    // Selection box visualization
    for (let pid in this.players) {
      let sel = this.players[pid].selection;
      if (sel && (pid === this.conn.id || (this.players[pid].cursorPosition && this.players[pid].cursorPosition.z < 2.0))) {
        if (!this.selectionMeshes[pid]) {
          let c = new THREE.Color(this.players[pid].color || "#ffffff");
          let mat = new THREE.MeshBasicMaterial({
            color: c, transparent: true, opacity: pid === this.conn.id ? 0.18 : 0.08, side: THREE.DoubleSide,
          });
          let m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
          m.rotation.x = -Math.PI / 2;
          m.position.y = 0.005;
          this.scene.add(m);
          this.selectionMeshes[pid] = m;
        }
        let sm = this.selectionMeshes[pid];
        sm.scale.set(sel.x2 - sel.x1, sel.z2 - sel.z1, 1);
        sm.position.x = (sel.x1 + sel.x2) / 2;
        sm.position.z = (sel.z1 + sel.z2) / 2;
        sm.visible = true;
      } else if (this.selectionMeshes[pid]) {
        this.selectionMeshes[pid].visible = false;
      }
    }

    // Render through the post-processing pipeline (SSGI + TRAA)
    this.renderPipeline.render();
  }

  // ── Server updates ────────────────────────────────────────────────

  /** @param {MessageEvent} event */
  updateFromServer(event) {
    /** @type {string} */
    let raw = event.data;
    if (!raw.startsWith("{")) return;
    let data = JSON.parse(raw);
    if (!data.type || !data.type.includes("update")) return;

    if (data.type === "fullupdate") {
      for (let c in this.cards)   this.cards[c].dirty   = true;
      for (let p in this.players) this.players[p].dirty = true;
    }

    // ── Cards ──
    for (let id in data.cards) {
      let dc = data.cards[id];
      if (!this.cards[id]) {
        this.cards[id] = dc;
        let mesh = this.createCardMesh(id, dc.suit, dc.value);
        if (dc.position)   mesh.position.set(dc.position.x, dc.position.y, dc.position.z);
        if (dc.quaternion) mesh.quaternion.set(dc.quaternion.x, dc.quaternion.y, dc.quaternion.z, dc.quaternion.w);
      } else {
        Object.assign(this.cards[id], dc);
      }

      let card = this.cards[id];
      let mesh = this.cardMeshes[id];
      if (mesh) {
        let vis = card.visibleOnlyTo === "all" || card.visibleOnlyTo === this.conn.id;
        mesh.visible = vis;

        // Selection glow
        if (card.selectedBy) {
          this.setHighlight(id, this.playersToColors[card.selectedBy] || "#ffffff");
        } else {
          this.clearHighlight(id);
        }
      }
      if (this.cards[id]) this.cards[id].dirty = false;
    }

    // ── Players ──
    for (let pid in data.players) {
      let dp = data.players[pid];
      if (!this.players[pid]) {
        this.players[pid] = dp;
        this.playersToColors[pid] = dp.color;
        if (pid !== this.conn.id) this.createCursorMesh(pid, dp.color);

        // Nametag
        /** @type {HTMLDivElement | HTMLInputElement} */
        let tag;
        if (pid === this.conn.id) {
          tag = /** @type {HTMLInputElement} */ (document.createElement("input"));
          tag.className = "player-nametag player-nametag-self";
          tag.value = dp.name;
          tag.addEventListener("input", () => {
            this.conn.send(JSON.stringify({ type: "name", name: /** @type {HTMLInputElement} */(tag).value }));
          });
        } else {
          tag = document.createElement("div");
          tag.className = "player-nametag";
          tag.style.color = dp.color;
          tag.textContent = dp.name;
        }
        this.players[pid].nametag = tag;
        this.playerList.appendChild(tag);
      } else {
        Object.assign(this.players[pid], dp);
        // Update nametag text
        if (pid !== this.conn.id && this.players[pid].nametag) {
          let n = 0;
          for (let c in this.cards) { if (this.cards[c].visibleOnlyTo === pid) n++; }
          this.players[pid].nametag.textContent = this.players[pid].name + " \u2013 " + n;
        }
      }
      if (this.players[pid]) this.players[pid].dirty = false;
    }

    // ── Cleanup stale on full update ──
    if (data.type === "fullupdate") {
      for (let c in this.cards) {
        if (this.cards[c].dirty) {
          if (this.cardMeshes[c]) { this.scene.remove(this.cardMeshes[c]); delete this.cardMeshes[c]; }
          this.clearHighlight(c);
          delete this.cards[c];
        }
      }
      for (let p in this.players) {
        if (this.players[p].dirty) {
          if (this.cursorMeshes[p]) { this.scene.remove(this.cursorMeshes[p]); delete this.cursorMeshes[p]; }
          if (this.selectionMeshes[p]) { this.scene.remove(this.selectionMeshes[p]); delete this.selectionMeshes[p]; }
          if (this.players[p].nametag) this.players[p].nametag.remove();
          delete this.players[p];
        }
      }
    }
  }

  // ── Highlight helpers ─────────────────────────────────────────────

  /** @param {string} cardId @param {string} color */
  setHighlight(cardId, color) {
    let mesh = this.cardMeshes[cardId];
    if (!mesh) return;
    if (!this.highlightMeshes[cardId]) {
      let mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(color), transparent: true, opacity: 0.45 });
      let m = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.005, 1.5), mat);
      mesh.add(m);
      this.highlightMeshes[cardId] = m;
    } else {
      /** @type {THREE.MeshBasicMaterial} */ (this.highlightMeshes[cardId].material).color.set(color);
    }
  }

  /** @param {string} cardId */
  clearHighlight(cardId) {
    if (this.highlightMeshes[cardId]) {
      let mesh = this.cardMeshes[cardId];
      if (mesh) mesh.remove(this.highlightMeshes[cardId]);
      this.highlightMeshes[cardId].geometry.dispose();
      /** @type {THREE.Material} */ (this.highlightMeshes[cardId].material).dispose();
      delete this.highlightMeshes[cardId];
    }
  }
}

new CardGame3D();
