// @ts-check
/** @typedef {import("partykit/server").Room} Room */
/** @typedef {import("partykit/server").Server} Server */
/** @typedef {import("partykit/server").Connection} Connection */
/** @typedef {import("partykit/server").ConnectionContext} ConnectionContext */

import PhysXInit from '../assets/physx/physx-js-webidl.mjs';
import physxWasm from '../assets/physx/physx-js-webidl.wasm';

// Card half-extents (1.0 x 0.02 x 1.4 full size)
const CH_X = 0.5, CH_Y = 0.01, CH_Z = 0.7;
// Table half-extents
const TH_X = 2.0, TH_Y = 0.05, TH_Z = 2.5;
const HAND_Z = 1.0;           // z boundary: above this = hand
const DECK_X = -1.5, DECK_Z = -2.0;
const GRAB_Y = 0.15;          // hover height while dragging

/** @implements {Server} */
class PartyServer {
  /** @param {Room} room */
  constructor(room) {
    this.room = room;
    this.suits  = ["CLUB", "SPADE", "HEART", "DIAMOND"];
    this.values = ["2","3","4","5","6","7","8","9","10","11-JACK","12-QUEEN","13-KING","1"];
    this.playerColors = ["#FF0000","#0000FF","#FFFF00","#FF00FF","#00FFFF","#FF8000","#FF0080","#8000FF","#0080FF","#80FF00","#00FF80","#FF8080","#8080FF","#FF80FF","#80FFFF","#FFFF80","#FF80FF"];

    /** @type {Record<string, {name:string, id:string, color:string, cursorPosition:{x:number,y:number,z:number}, cursorPressed:boolean, selection:{x1:number,z1:number,x2:number,z2:number}|null}>} */
    this.players = {};
    /** @type {Record<string, {suit:string, value:string, flipped:boolean, visibleOnlyTo:string, selectedBy:string|null, inHand:boolean}>} */
    this.cards = {};
    /** @type {Record<string, any>} PhysX body per card */
    this.physCards = {};
    /** @type {Record<string, {anchor:any, joints:any[], cards:string[]}>} Active grabs */
    this.grabs = {};
    /** @type {Record<string, boolean>} */
    this.needsUpdate = {};

    this.globalPlayerCount = 0;
    this.hasNewInfoToSend = false;
    this.updateCounter = 0;
  }

  async onStart() {
    await this.initPhysX();
    this.createTable();
    this.createWalls();
    this.createAllCards();
    this.startUpdateLoop();
  }

  // ── PhysX Initialization ──────────────────────────────────────────

  async initPhysX() {
    this.px = await PhysXInit({
      instantiateWasm: (/** @type {any} */ imports, /** @type {any} */ callback) => {
        const instance = new WebAssembly.Instance(physxWasm, imports);
        callback(instance);
        return instance.exports;
      }
    });

    let version = this.px.PHYSICS_VERSION;
    let allocator = new this.px.PxDefaultAllocator();
    let errorCb   = new this.px.PxDefaultErrorCallback();
    let foundation = this.px.CreateFoundation(version, allocator, errorCb);

    let tolerances = new this.px.PxTolerancesScale();
    this.pxPhysics = this.px.CreatePhysics(version, foundation, tolerances);

    let gravity = new this.px.PxVec3(0, -9.81, 0);
    let sceneDesc = new this.px.PxSceneDesc(tolerances);
    sceneDesc.set_gravity(gravity);
    sceneDesc.set_cpuDispatcher(this.px.DefaultCpuDispatcherCreate(0));
    sceneDesc.set_filterShader(this.px.DefaultFilterShader());
    this.pxScene = this.pxPhysics.createScene(sceneDesc);

    this.pxMaterial = this.pxPhysics.createMaterial(0.6, 0.6, 0.15);
    this.pxFilterData = new this.px.PxFilterData(1, 1, 0, 0);
    this.pxShapeFlags = new this.px.PxShapeFlags(
      this.px.PxShapeFlagEnum.eSCENE_QUERY_SHAPE |
      this.px.PxShapeFlagEnum.eSIMULATION_SHAPE
    );

    // Reusable temp objects to avoid per-frame WASM allocation
    this.pxTmpVec  = new this.px.PxVec3(0, 0, 0);
    this.pxTmpQuat = new this.px.PxQuat(0, 0, 0, 1);
    this.pxTmpPose = new this.px.PxTransform(this.pxTmpVec, this.pxTmpQuat);
    this.lastPhysTime = Date.now();
    console.log("PhysX initialized");
  }

  // ── Static geometry ───────────────────────────────────────────────

  /** @param {number} x @param {number} y @param {number} z @param {number} hx @param {number} hy @param {number} hz */
  addStaticBox(x, y, z, hx, hy, hz) {
    let geom  = new this.px.PxBoxGeometry(hx, hy, hz);
    let v     = new this.px.PxVec3(x, y, z);
    let q     = new this.px.PxQuat(0, 0, 0, 1);
    let pose  = new this.px.PxTransform(v, q);
    let sf    = new this.px.PxShapeFlags(
      this.px.PxShapeFlagEnum.eSCENE_QUERY_SHAPE |
      this.px.PxShapeFlagEnum.eSIMULATION_SHAPE
    );
    let shape = this.pxPhysics.createShape(geom, this.pxMaterial, true, sf);
    shape.setSimulationFilterData(this.pxFilterData);
    let actor = this.pxPhysics.createRigidStatic(pose);
    actor.attachShape(shape);
    this.pxScene.addActor(actor);
  }

  createTable() {
    this.addStaticBox(0, -TH_Y, 0, TH_X, TH_Y, TH_Z);
  }

  createWalls() {
    let wt = 0.1, wh = 1.0;
    this.addStaticBox(-TH_X - wt, wh / 2, 0,    wt, wh / 2, TH_Z);    // left
    this.addStaticBox( TH_X + wt, wh / 2, 0,    wt, wh / 2, TH_Z);    // right
    this.addStaticBox(0, wh / 2, -TH_Z - wt,    TH_X, wh / 2, wt);    // far
    this.addStaticBox(0, wh / 2,  TH_Z + wt,    TH_X, wh / 2, wt);    // near
  }

  // ── Card creation ─────────────────────────────────────────────────

  createAllCards() {
    let cardGeom = new this.px.PxBoxGeometry(CH_X, CH_Y, CH_Z);

    for (let s = 0; s < this.suits.length; s++) {
      for (let v = 0; v < this.values.length; v++) {
        let id = this.suits[s] + "=" + this.values[v];
        let stackIdx = s * 13 + v;
        let stackY = CH_Y + stackIdx * CH_Y * 2.5;

        let bv = new this.px.PxVec3(DECK_X, stackY, DECK_Z);
        // Face-down: 180° around X → quat (1, 0, 0, 0)
        let bq = new this.px.PxQuat(1, 0, 0, 0);
        let bpose = new this.px.PxTransform(bv, bq);

        let sf = new this.px.PxShapeFlags(
          this.px.PxShapeFlagEnum.eSCENE_QUERY_SHAPE |
          this.px.PxShapeFlagEnum.eSIMULATION_SHAPE
        );
        let shape = this.pxPhysics.createShape(cardGeom, this.pxMaterial, true, sf);
        shape.setSimulationFilterData(this.pxFilterData);

        let body = this.pxPhysics.createRigidDynamic(bpose);
        body.attachShape(shape);
        this.px.PxRigidBodyExt.prototype.updateMassAndInertia(body, 10.0);
        body.setLinearDamping(3.0);
        body.setAngularDamping(3.0);
        this.pxScene.addActor(body);

        this.cards[id] = {
          suit: this.suits[s], value: this.values[v],
          flipped: true, visibleOnlyTo: "all", selectedBy: null, inHand: false,
        };
        this.physCards[id] = body;
        this.needsUpdate[id] = true;
      }
    }
  }

  // ── Physics stepping ──────────────────────────────────────────────

  stepPhysics() {
    if (!this.pxScene) return;
    let now = Date.now();
    let dt = Math.min((now - this.lastPhysTime) / 1000, 0.05);
    this.lastPhysTime = now;
    if (dt <= 0) return;

    this.pxScene.simulate(dt);
    this.pxScene.fetchResults(true);

    for (let id in this.physCards) {
      if (this.cards[id].inHand) continue;
      if (!this.physCards[id].isSleeping()) {
        this.needsUpdate[id] = true;
        this.hasNewInfoToSend = true;
      }
      // Reset cards that fell off
      let p = this.physCards[id].getGlobalPose().get_p();
      if (p.get_y() < -3) this.resetCard(id);
    }
  }

  // ── Broadcast loop ────────────────────────────────────────────────

  startUpdateLoop() {
    this.interval = setInterval(() => {
      this.stepPhysics();
      if (!this.hasNewInfoToSend) return;

      let cardsState = this.getCardsState();

      if (this.updateCounter % 30 === 0) {
        this.room.broadcast(JSON.stringify({
          type: "fullupdate", players: this.players, cards: cardsState,
        }));
        for (let k in this.needsUpdate) this.needsUpdate[k] = false;
      } else {
        let partial = { type: "partialupdate", players: /** @type {any} */({}), cards: /** @type {any} */({}) };
        for (let p in this.players) {
          if (this.needsUpdate[p]) { partial.players[p] = this.players[p]; this.needsUpdate[p] = false; }
        }
        for (let c in cardsState) {
          if (this.needsUpdate[c]) { partial.cards[c] = cardsState[c]; this.needsUpdate[c] = false; }
        }
        this.room.broadcast(JSON.stringify(partial));
      }
      this.updateCounter++;
      this.hasNewInfoToSend = false;
    }, 1000 / 30);
  }

  getCardsState() {
    let out = /** @type {any} */ ({});
    for (let id in this.cards) {
      let c = this.cards[id];
      let pose = this.physCards[id].getGlobalPose();
      let p = pose.get_p(), q = pose.get_q();
      out[id] = {
        suit: c.suit, value: c.value,
        position:   { x: p.get_x(), y: p.get_y(), z: p.get_z() },
        quaternion: { x: q.get_x(), y: q.get_y(), z: q.get_z(), w: q.get_w() },
        flipped: c.flipped, visibleOnlyTo: c.visibleOnlyTo, selectedBy: c.selectedBy,
      };
    }
    return out;
  }

  // ── Grab / Move / Release (D6 joints) ────────────────────────────

  /** @param {string} playerId @param {string} cardId */
  handleGrab(playerId, cardId) {
    if (this.grabs[playerId]) this.handleRelease(playerId);
    let player = this.players[playerId];
    if (!player) return;
    let cur = player.cursorPosition;

    // Gather selected cards (or just the clicked one)
    let selected = [];
    if (this.cards[cardId] && this.cards[cardId].selectedBy === playerId) {
      for (let c in this.cards) {
        if (this.cards[c].selectedBy === playerId) selected.push(c);
      }
    }
    if (selected.length === 0) selected = [cardId];

    // Make hand cards dynamic before attaching joints
    for (let c of selected) {
      if (this.cards[c].inHand) {
        this.physCards[c].setRigidBodyFlag(this.px.PxRigidBodyFlagEnum.eKINEMATIC, false);
        this.pxTmpVec.set_x(0); this.pxTmpVec.set_y(0); this.pxTmpVec.set_z(0);
        this.physCards[c].setLinearVelocity(this.pxTmpVec);
        this.physCards[c].setAngularVelocity(this.pxTmpVec);
        this.physCards[c].wakeUp();
        this.cards[c].inHand = false;
      }
    }

    // Kinematic anchor at cursor position
    let av = new this.px.PxVec3(cur.x, GRAB_Y, cur.z);
    let aq = new this.px.PxQuat(0, 0, 0, 1);
    let anchor = this.pxPhysics.createRigidDynamic(new this.px.PxTransform(av, aq));
    anchor.setRigidBodyFlag(this.px.PxRigidBodyFlagEnum.eKINEMATIC, true);
    this.pxScene.addActor(anchor);

    let joints = [];
    for (let c of selected) {
      let body = this.physCards[c];
      body.wakeUp();
      let bp = body.getGlobalPose().get_p();
      let ox = bp.get_x() - cur.x;
      let oy = bp.get_y() - GRAB_Y;
      let oz = bp.get_z() - cur.z;

      let anchorFrame = new this.px.PxTransform(
        new this.px.PxVec3(ox, oy, oz), new this.px.PxQuat(0, 0, 0, 1));
      let bodyFrame = new this.px.PxTransform(this.px.PxIDENTITYEnum.PxIdentity);
      let joint = this.px.D6JointCreate(this.pxPhysics, anchor, anchorFrame, body, bodyFrame);

      joint.setMotion(this.px.PxD6AxisEnum.eX,      this.px.PxD6MotionEnum.eFREE);
      joint.setMotion(this.px.PxD6AxisEnum.eY,      this.px.PxD6MotionEnum.eFREE);
      joint.setMotion(this.px.PxD6AxisEnum.eZ,      this.px.PxD6MotionEnum.eFREE);
      joint.setMotion(this.px.PxD6AxisEnum.eTWIST,  this.px.PxD6MotionEnum.eFREE);
      joint.setMotion(this.px.PxD6AxisEnum.eSWING1, this.px.PxD6MotionEnum.eFREE);
      joint.setMotion(this.px.PxD6AxisEnum.eSWING2, this.px.PxD6MotionEnum.eFREE);

      let linDrive = new this.px.PxD6JointDrive(800, 120, Infinity, true);
      joint.setDrive(this.px.PxD6DriveEnum.eX, linDrive);
      joint.setDrive(this.px.PxD6DriveEnum.eY, linDrive);
      joint.setDrive(this.px.PxD6DriveEnum.eZ, linDrive);
      let angDrive = new this.px.PxD6JointDrive(300, 50, Infinity, true);
      joint.setDrive(this.px.PxD6DriveEnum.eSLERP, angDrive);

      joints.push(joint);
      this.needsUpdate[c] = true;
    }

    this.grabs[playerId] = { anchor, joints, cards: selected };
    this.hasNewInfoToSend = true;
  }

  /** @param {string} playerId */
  handleMove(playerId) {
    let grab = this.grabs[playerId];
    if (!grab) return;
    let pos = this.players[playerId].cursorPosition;

    this.pxTmpVec.set_x(pos.x);
    this.pxTmpVec.set_y(GRAB_Y);
    this.pxTmpVec.set_z(pos.z);
    this.pxTmpQuat.set_x(0); this.pxTmpQuat.set_y(0);
    this.pxTmpQuat.set_z(0); this.pxTmpQuat.set_w(1);
    this.pxTmpPose.set_p(this.pxTmpVec);
    this.pxTmpPose.set_q(this.pxTmpQuat);
    grab.anchor.setKinematicTarget(this.pxTmpPose);

    // Wake grabbed bodies + check visibility boundary
    for (let c of grab.cards) {
      this.physCards[c].wakeUp();
      let cz = this.physCards[c].getGlobalPose().get_p().get_z();
      if (cz < HAND_Z) {
        this.cards[c].visibleOnlyTo = "all";
      } else if (this.cards[c].visibleOnlyTo === "all") {
        this.cards[c].visibleOnlyTo = playerId;
      }
      this.needsUpdate[c] = true;
    }
    this.hasNewInfoToSend = true;
  }

  /** @param {string} playerId */
  handleRelease(playerId) {
    let grab = this.grabs[playerId];
    if (!grab) return;

    for (let j of grab.joints) j.release();
    this.pxScene.removeActor(grab.anchor);

    for (let c of grab.cards) {
      let cz = this.physCards[c].getGlobalPose().get_p().get_z();
      if (cz >= HAND_Z && this.cards[c].visibleOnlyTo === playerId) {
        this.cards[c].inHand = true;
        this.physCards[c].setRigidBodyFlag(this.px.PxRigidBodyFlagEnum.eKINEMATIC, true);
      } else {
        this.physCards[c].wakeUp();
      }
      this.needsUpdate[c] = true;
    }
    delete this.grabs[playerId];
    this.layoutHand(playerId);
    this.hasNewInfoToSend = true;
  }

  // ── Hand layout ───────────────────────────────────────────────────

  /** @param {string} playerId */
  layoutHand(playerId) {
    let handCards = [];
    for (let c in this.cards) {
      if (this.cards[c].visibleOnlyTo === playerId && this.cards[c].inHand) handCards.push(c);
    }
    let n = handCards.length;
    if (n === 0) return;
    let startX = -1.5, endX = 1.5, handZ = 2.0;
    for (let i = 0; i < n; i++) {
      let x = n > 1 ? startX + (endX - startX) * i / (n - 1) : 0;
      this.pxTmpVec.set_x(x);
      this.pxTmpVec.set_y(CH_Y + 0.01);
      this.pxTmpVec.set_z(handZ);
      if (this.cards[handCards[i]].flipped) {
        this.pxTmpQuat.set_x(1); this.pxTmpQuat.set_y(0);
        this.pxTmpQuat.set_z(0); this.pxTmpQuat.set_w(0);
      } else {
        this.pxTmpQuat.set_x(0); this.pxTmpQuat.set_y(0);
        this.pxTmpQuat.set_z(0); this.pxTmpQuat.set_w(1);
      }
      this.pxTmpPose.set_p(this.pxTmpVec);
      this.pxTmpPose.set_q(this.pxTmpQuat);
      this.physCards[handCards[i]].setKinematicTarget(this.pxTmpPose);
      this.needsUpdate[handCards[i]] = true;
    }
  }

  // ── Flip ──────────────────────────────────────────────────────────

  /** @param {string} playerId @param {string} cardId */
  handleFlip(playerId, cardId) {
    let toFlip = [];
    if (this.cards[cardId].selectedBy === playerId) {
      for (let c in this.cards) {
        if (this.cards[c].selectedBy === playerId) toFlip.push(c);
      }
    } else {
      toFlip = [cardId];
    }

    for (let c of toFlip) {
      this.cards[c].flipped = !this.cards[c].flipped;
      let body = this.physCards[c];

      if (!this.cards[c].inHand) {
        body.wakeUp();
        let pose = body.getGlobalPose();
        let p = pose.get_p(), q = pose.get_q();
        let qx = q.get_x(), qy = q.get_y(), qz = q.get_z(), qw = q.get_w();
        // Multiply by 180° around local X: q_flip = (1, 0, 0, 0)
        let nw = -qx, nx = qw, ny = qz, nz = -qy;

        this.pxTmpVec.set_x(p.get_x());
        this.pxTmpVec.set_y(p.get_y() + 0.3);
        this.pxTmpVec.set_z(p.get_z());
        this.pxTmpQuat.set_x(nx); this.pxTmpQuat.set_y(ny);
        this.pxTmpQuat.set_z(nz); this.pxTmpQuat.set_w(nw);
        this.pxTmpPose.set_p(this.pxTmpVec);
        this.pxTmpPose.set_q(this.pxTmpQuat);
        body.setGlobalPose(this.pxTmpPose);

        this.pxTmpVec.set_x(0); this.pxTmpVec.set_y(0); this.pxTmpVec.set_z(0);
        body.setLinearVelocity(this.pxTmpVec);
        body.setAngularVelocity(this.pxTmpVec);
      }
      this.needsUpdate[c] = true;
    }
    this.layoutHand(playerId);
    this.hasNewInfoToSend = true;
  }

  // ── Selection ─────────────────────────────────────────────────────

  /** @param {string} playerId @param {{x1:number,z1:number,x2:number,z2:number}} sel */
  handleSelection(playerId, sel) {
    this.players[playerId].selection = sel;
    for (let c in this.cards) {
      let pp = this.physCards[c].getGlobalPose().get_p();
      let cx = pp.get_x(), cz = pp.get_z();
      if (cx > sel.x1 && cx < sel.x2 && cz > sel.z1 && cz < sel.z2) {
        if (this.cards[c].visibleOnlyTo === "all" || this.cards[c].visibleOnlyTo === playerId) {
          this.cards[c].selectedBy = playerId;
          this.needsUpdate[c] = true;
        }
      } else if (this.cards[c].selectedBy === playerId) {
        this.cards[c].selectedBy = null;
        this.needsUpdate[c] = true;
      }
    }
    this.needsUpdate[playerId] = true;
    this.hasNewInfoToSend = true;
  }

  // ── Sort ──────────────────────────────────────────────────────────

  /** @param {string} playerId @param {string} sortType */
  handleSort(playerId, sortType) {
    let hc = [];
    for (let c in this.cards) {
      if (this.cards[c].visibleOnlyTo === playerId && this.cards[c].inHand) hc.push(c);
    }
    if (sortType === "sortSuit") {
      hc.sort((a, b) => {
        let sd = this.suits.indexOf(this.cards[b].suit) - this.suits.indexOf(this.cards[a].suit);
        return sd !== 0 ? sd : this.values.indexOf(this.cards[b].value) - this.values.indexOf(this.cards[a].value);
      });
    } else {
      hc.sort((a, b) => {
        let vd = this.values.indexOf(this.cards[b].value) - this.values.indexOf(this.cards[a].value);
        return vd !== 0 ? vd : this.suits.indexOf(this.cards[b].suit) - this.suits.indexOf(this.cards[a].suit);
      });
    }
    let n = hc.length, startX = -1.5, endX = 1.5, handZ = 2.0;
    for (let i = 0; i < n; i++) {
      let x = n > 1 ? startX + (endX - startX) * i / (n - 1) : 0;
      this.pxTmpVec.set_x(x); this.pxTmpVec.set_y(CH_Y + 0.01); this.pxTmpVec.set_z(handZ);
      if (this.cards[hc[i]].flipped) {
        this.pxTmpQuat.set_x(1); this.pxTmpQuat.set_y(0); this.pxTmpQuat.set_z(0); this.pxTmpQuat.set_w(0);
      } else {
        this.pxTmpQuat.set_x(0); this.pxTmpQuat.set_y(0); this.pxTmpQuat.set_z(0); this.pxTmpQuat.set_w(1);
      }
      this.pxTmpPose.set_p(this.pxTmpVec);
      this.pxTmpPose.set_q(this.pxTmpQuat);
      this.physCards[hc[i]].setKinematicTarget(this.pxTmpPose);
      this.needsUpdate[hc[i]] = true;
    }
    this.hasNewInfoToSend = true;
  }

  // ── Reset / Deal ──────────────────────────────────────────────────

  /** @param {string} cardId */
  resetCard(cardId) {
    let body = this.physCards[cardId];
    if (this.cards[cardId].inHand) {
      body.setRigidBodyFlag(this.px.PxRigidBodyFlagEnum.eKINEMATIC, false);
    }
    this.pxTmpVec.set_x(DECK_X);
    this.pxTmpVec.set_y(CH_Y + 0.5);
    this.pxTmpVec.set_z(DECK_Z);
    this.pxTmpQuat.set_x(1); this.pxTmpQuat.set_y(0);
    this.pxTmpQuat.set_z(0); this.pxTmpQuat.set_w(0);
    this.pxTmpPose.set_p(this.pxTmpVec);
    this.pxTmpPose.set_q(this.pxTmpQuat);
    body.setGlobalPose(this.pxTmpPose);
    this.pxTmpVec.set_x(0); this.pxTmpVec.set_y(0); this.pxTmpVec.set_z(0);
    body.setLinearVelocity(this.pxTmpVec);
    body.setAngularVelocity(this.pxTmpVec);
    body.wakeUp();
    Object.assign(this.cards[cardId], {
      flipped: true, visibleOnlyTo: "all", selectedBy: null, inHand: false,
    });
    this.needsUpdate[cardId] = true;
    this.hasNewInfoToSend = true;
  }

  handleReset() {
    for (let pid in this.grabs) this.handleRelease(pid);
    let idx = 0;
    for (let c in this.cards) {
      let body = this.physCards[c];
      if (this.cards[c].inHand) {
        body.setRigidBodyFlag(this.px.PxRigidBodyFlagEnum.eKINEMATIC, false);
      }
      let stackY = CH_Y + idx * CH_Y * 2.5;
      this.pxTmpVec.set_x(DECK_X); this.pxTmpVec.set_y(stackY); this.pxTmpVec.set_z(DECK_Z);
      this.pxTmpQuat.set_x(1); this.pxTmpQuat.set_y(0); this.pxTmpQuat.set_z(0); this.pxTmpQuat.set_w(0);
      this.pxTmpPose.set_p(this.pxTmpVec); this.pxTmpPose.set_q(this.pxTmpQuat);
      body.setGlobalPose(this.pxTmpPose);
      this.pxTmpVec.set_x(0); this.pxTmpVec.set_y(0); this.pxTmpVec.set_z(0);
      body.setLinearVelocity(this.pxTmpVec);
      body.setAngularVelocity(this.pxTmpVec);
      body.wakeUp();
      Object.assign(this.cards[c], {
        flipped: true, visibleOnlyTo: "all", selectedBy: null, inHand: false,
      });
      this.needsUpdate[c] = true;
      idx++;
    }
    this.hasNewInfoToSend = true;
  }

  /** @param {string} playerId */
  handleDeal(playerId) {
    let topCard = null, topY = -Infinity;
    for (let c in this.cards) {
      if (this.cards[c].inHand) continue;
      let pp = this.physCards[c].getGlobalPose().get_p();
      if (Math.abs(pp.get_x() - DECK_X) < CH_X * 2 && Math.abs(pp.get_z() - DECK_Z) < CH_Z * 2) {
        if (pp.get_y() > topY) { topY = pp.get_y(); topCard = c; }
      }
    }
    if (!topCard) return;

    let body = this.physCards[topCard];
    body.wakeUp();

    // Flip the card face-up via quaternion
    this.cards[topCard].flipped = false;
    let pose = body.getGlobalPose();
    let p = pose.get_p(), q = pose.get_q();
    let qx = q.get_x(), qy = q.get_y(), qz = q.get_z(), qw = q.get_w();
    let nw = -qx, nx = qw, ny = qz, nz = -qy;
    this.pxTmpVec.set_x(p.get_x()); this.pxTmpVec.set_y(p.get_y() + 0.2); this.pxTmpVec.set_z(p.get_z());
    this.pxTmpQuat.set_x(nx); this.pxTmpQuat.set_y(ny);
    this.pxTmpQuat.set_z(nz); this.pxTmpQuat.set_w(nw);
    this.pxTmpPose.set_p(this.pxTmpVec); this.pxTmpPose.set_q(this.pxTmpQuat);
    body.setGlobalPose(this.pxTmpPose);

    // Fling the card across the table
    this.pxTmpVec.set_x(3.0); this.pxTmpVec.set_y(1.5); this.pxTmpVec.set_z(2.0);
    body.setLinearVelocity(this.pxTmpVec);

    this.needsUpdate[topCard] = true;
    this.hasNewInfoToSend = true;
  }

  // ── Connection lifecycle ──────────────────────────────────────────

  /** @param {Connection} conn @param {ConnectionContext} ctx */
  onConnect(conn, ctx) {
    this.globalPlayerCount++;
    this.players[conn.id] = {
      name: "noob " + this.globalPlayerCount,
      color: this.playerColors[this.globalPlayerCount % this.playerColors.length],
      id: conn.id,
      cursorPosition: { x: 0, y: 0, z: 0 },
      cursorPressed: false,
      selection: null,
    };
    this.needsUpdate[conn.id] = true;
    this.room.broadcast(JSON.stringify({
      type: "fullupdate", players: this.players, cards: this.getCardsState(),
    }));
  }

  /** @param {Connection} conn */
  onDisconnect(conn) {
    if (this.grabs[conn.id]) this.handleRelease(conn.id);
    for (let c in this.cards) {
      if (this.cards[c].visibleOnlyTo === conn.id) this.resetCard(c);
      if (this.cards[c].selectedBy === conn.id) {
        this.cards[c].selectedBy = null;
        this.needsUpdate[c] = true;
      }
    }
    delete this.players[conn.id];
    delete this.needsUpdate[conn.id];
    this.room.broadcast(JSON.stringify({
      type: "fullupdate", players: this.players, cards: this.getCardsState(),
    }));
  }

  /** @param {Connection} conn */
  onClose(conn) { this.onDisconnect(conn); }
  /** @param {Connection} conn @param {Error} error */
  onError(conn, error) { console.error(error); this.onDisconnect(conn); }

  // ── Message dispatch ──────────────────────────────────────────────

  /** @param {string} message @param {Connection} sender */
  onMessage(message, sender) {
    if (!message.startsWith("{")) return;
    let data = JSON.parse(message);
    switch (data.type) {
      case "cursor":
        this.players[sender.id].cursorPosition = data.cursorPosition;
        this.players[sender.id].cursorPressed  = data.cursorPressed;
        this.needsUpdate[sender.id] = true;
        if (this.grabs[sender.id]) this.handleMove(sender.id);
        break;
      case "grab":
        this.handleGrab(sender.id, data.card);
        break;
      case "release":
        this.handleRelease(sender.id);
        break;
      case "cardFlip":
        this.handleFlip(sender.id, data.card);
        break;
      case "selection":
        this.handleSelection(sender.id, data.selection);
        break;
      case "endSelection":
        this.players[sender.id].selection = null;
        this.needsUpdate[sender.id] = true;
        this.hasNewInfoToSend = true;
        break;
      case "deselect":
        for (let c in this.cards) {
          if (this.cards[c].selectedBy === sender.id) {
            this.cards[c].selectedBy = null;
            this.needsUpdate[c] = true;
          }
        }
        this.hasNewInfoToSend = true;
        break;
      case "name":
        this.players[sender.id].name = data.name;
        this.needsUpdate[sender.id] = true;
        this.hasNewInfoToSend = true;
        break;
      case "reset":
        this.handleReset();
        break;
      case "deal":
        this.handleDeal(sender.id);
        break;
      case "sortSuit": case "sortRank":
        this.handleSort(sender.id, data.type);
        break;
      default:
        console.error("Unknown message type:", data.type);
    }
    this.hasNewInfoToSend = true;
  }
}

export default PartyServer;
