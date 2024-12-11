/* eslint-env browser */
/* global PARTYKIT_HOST */

import "./styles.css";
import PartySocket from "partysocket";
import lap from "./lap.js";

class CardGame {
  constructor() {
    this.queryParams = new URLSearchParams(window.location.search || window.location.hash.substr(1));
    if(this.queryParams.has("room")){
      this.curRoom = this.queryParams.get('room') || "global";
    }else{
      this.curRoom = "global";
      this.queryParams.set("room", this.curRoom);
      window.history.replaceState({}, "", `${window.location.pathname}?${this.queryParams.toString()}`);
    }

    /** @type {PartySocket} - The connection object */
    this.conn = new PartySocket({
      // @ts-expect-error This should be typed as a global string
      host: PARTYKIT_HOST,
      room: this.curRoom,
    });

    this.suits  = ["CLUB", "SPADE", "HEART", "DIAMOND"];
    this.values = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "11-JACK", "12-QUEEN", "13-KING", "1"];

    /** @type {HTMLDivElement} - The DOM element to append all messages we get */
    this.output = /** @type {HTMLDivElement} */ (document.body);//getElementById("app"));

    /** @type {Record<string, { suit: string, value: string, position: { x: number, y: number }, renderPosition: { x: number, y: number }, rotation: number, flipped: boolean, dirty: boolean, element: HTMLImageElement, visibleOnlyTo: string, selectedBy: string | null, zIndex: number }>} */
    this.cards   = {};
    /** @type {Record<string, { name: string, id:string, color:string, cursorPosition: { x: number, y: number }, renderPosition: { x: number, y: number }, selection: {x1: number, y1: number, x2: number, y2: number} | null, renderSelection: {x1: number, y1: number, x2: number, y2: number}, cursorPressed: boolean, dirty: boolean, element: HTMLImageElement, selectionElement: HTMLDivElement, nametag: HTMLDivElement }>} */
    this.players = {};

    this.playersToColors = {
      null: "black"
    };

    this.curDragging = undefined;
    /** @type {{x:number, y:number} | null} */
    this.selectionStart = null;

    this.highestZIndex = 10000;

    this.conn.addEventListener("open"   , this.start           .bind(this));
    this.conn.addEventListener("message", this.updateFromServer.bind(this));

    window.addEventListener("pointermove", this.sendMouseUpdate.bind(this));
    window.addEventListener("pointerdown", this.sendMouseUpdate.bind(this));
    window.addEventListener("pointerup"  , this.sendMouseUpdate.bind(this));

    this.animationCallback = this.updateOnClient.bind(this);

    document.body.style.backgroundImage = "url('./background.jpg')";
    document.body.style.backgroundRepeat = "repeat";

    // Add player list to the top right hand corner of the screen
    this.playerList = document.createElement("div");
    this.playerList.style.position = "absolute";
    this.playerList.style.width = "130px";
    this.playerList.style.height = "100px";
    this.playerList.style.top = "0px";
    this.playerList.style.left = "270px";
    //this.playerList.style.backgroundColor = "rgba(255, 255, 255, 0.4)";
    //this.playerList.style.border = "10px solid black";
    //this.playerList.style.borderRadius = "20px";
    //this.playerList.style.zIndex = "0";
    //this.playerList.style.textAlign = "center";
    //this.playerList.style.verticalAlign = "middle";
    //this.playerList.style.lineHeight = "20px";
    //this.playerList.style.fontSize = "20px";
    this.playerList.style.pointerEvents = "none";
    //this.playerList.textContent = "Players:";
    document.body.appendChild(this.playerList);

    this.hand = document.createElement("div");
    this.hand.style.position = "absolute";
    this.hand.style.width = "380px";
    this.hand.style.height = "160px";
    this.hand.style.top = "455px";
    this.hand.style.left = "0px";
    this.hand.style.backgroundColor = "rgba(255, 255, 255, 0.4)";
    this.hand.style.border = "10px solid black";
    this.hand.style.borderRadius = "20px";
    this.hand.style.zIndex = "0";
    this.hand.style.textAlign = "center";
    this.hand.style.verticalAlign = "middle";
    this.hand.style.lineHeight = "160px";
    this.hand.style.fontSize = "50px";
    this.hand.style.pointerEvents = "none";
    this.hand.textContent = "Your Hand";
    document.body.appendChild(this.hand);

    // Add a button to deal the player one card
    this.dealButton = document.createElement("button");
    this.dealButton.style.position = "absolute";
    this.dealButton.style.width = "170px";
    this.dealButton.style.height = "50px";
    this.dealButton.style.top = "40px";
    this.dealButton.style.left = "100px";
    this.dealButton.style.backgroundColor = "rgba(255, 255, 255, 0.4)";
    this.dealButton.style.border = "10px solid black";
    this.dealButton.style.borderRadius = "20px";
    this.dealButton.style.zIndex = "0";
    this.dealButton.style.textAlign = "center";
    this.dealButton.style.verticalAlign = "middle";
    this.dealButton.style.lineHeight = "20px";
    this.dealButton.style.fontSize = "20px";
    this.dealButton.style.pointerEvents = "auto";
    this.dealButton.textContent = "Deal Card";
    this.dealButton.addEventListener("click", () => {
      // Select a random card that is in the top left corner of the screen and deal it to your hand
      let maxZIndex = -1;
      let topCard = undefined;
      for(let card in this.cards){
        if(this.cards[card].position.x < 25 && this.cards[card].position.y < 35 && this.cards[card].zIndex > maxZIndex){
          maxZIndex = this.cards[card].zIndex;
          topCard = card;
        }
      }
      if(topCard === undefined){ this.add("No cards to deal!"); return; }
      this.conn.send(JSON.stringify({
        type: "card",
        card: topCard,
        movement: {
          x: 1000,
          y: 1000,
        },
      }));
      setTimeout(() => {
        this.conn.send(JSON.stringify({
          type: "cardFlip",
          card: topCard
        }));
      }, 100);
    });
    document.body.appendChild(this.dealButton);

    // Add a button to deal the player one card
    this.resetButton = document.createElement("button");
    this.resetButton.style.position = "absolute";
    this.resetButton.style.width = "170px";
    this.resetButton.style.height = "50px";
    this.resetButton.style.top = "0px";
    this.resetButton.style.left = "100px";
    this.resetButton.style.backgroundColor = "rgba(255, 255, 255, 0.4)";
    this.resetButton.style.border = "10px solid black";
    this.resetButton.style.borderRadius = "20px";
    this.resetButton.style.zIndex = "0";
    this.resetButton.style.textAlign = "center";
    this.resetButton.style.verticalAlign = "middle";
    this.resetButton.style.lineHeight = "20px";
    this.resetButton.style.fontSize = "20px";
    this.resetButton.style.pointerEvents = "auto";
    this.resetButton.textContent = "Reset";
    this.resetButton.addEventListener("click", () => {
      this.conn.send(JSON.stringify({ type: "reset" }));
    });
    document.body.appendChild(this.resetButton);

    // Add a button to deal the player one card
    this.sortSuitButton = document.createElement("button");
    this.sortSuitButton.style.position = "absolute";
    this.sortSuitButton.style.width = "150px";
    this.sortSuitButton.style.height = "50px";
    this.sortSuitButton.style.top = "630px";
    this.sortSuitButton.style.left = "200px";
    this.sortSuitButton.style.backgroundColor = "rgba(255, 255, 255, 0.4)";
    this.sortSuitButton.style.border = "10px solid black";
    this.sortSuitButton.style.borderRadius = "20px";
    this.sortSuitButton.style.zIndex = "0";
    this.sortSuitButton.style.textAlign = "center";
    this.sortSuitButton.style.verticalAlign = "middle";
    this.sortSuitButton.style.lineHeight = "20px";
    this.sortSuitButton.style.fontSize = "20px";
    this.sortSuitButton.style.pointerEvents = "auto";
    this.sortSuitButton.textContent = "Sort Suit";
    this.sortSuitButton.addEventListener("click", () => {
      this.conn.send(JSON.stringify({ type: "sortSuit" }));
    });
    document.body.appendChild(this.sortSuitButton);
    this.sortSuitButton = document.createElement("button");
    this.sortSuitButton.style.position = "absolute";
    this.sortSuitButton.style.width = "150px";
    this.sortSuitButton.style.height = "50px";
    this.sortSuitButton.style.top = "630px";
    this.sortSuitButton.style.left = "50px";
    this.sortSuitButton.style.backgroundColor = "rgba(255, 255, 255, 0.4)";
    this.sortSuitButton.style.border = "10px solid black";
    this.sortSuitButton.style.borderRadius = "20px";
    this.sortSuitButton.style.zIndex = "0";
    this.sortSuitButton.style.textAlign = "center";
    this.sortSuitButton.style.verticalAlign = "middle";
    this.sortSuitButton.style.lineHeight = "20px";
    this.sortSuitButton.style.fontSize = "20px";
    this.sortSuitButton.style.pointerEvents = "auto";
    this.sortSuitButton.textContent = "Sort Rank";
    this.sortSuitButton.addEventListener("click", () => {
      this.conn.send(JSON.stringify({ type: "sortRank" }));
    });
    document.body.appendChild(this.sortSuitButton);


    this.lastDown = 0.0;
    this.previousDown = 0.0;

    this.prevTime = 0.0;
    this.time = 0.0;
  }

  /** @param {PointerEvent} event */
  sendMouseUpdate(event) {
    // Let go of a card if the pointer is not depressed
    this.curDragging = event.buttons > 0 ? this.curDragging : undefined;

    this.conn.send(JSON.stringify({
      type: "cursor",
      cursorPosition: {
        x: event.pageX,
        y: event.pageY,
      },
      cursorPressed: event.buttons > 0,
    }));

    if(this.curDragging !== undefined) {
      if (event.type === "pointerdown") {
        this.previousDown = this.lastDown;
        this.lastDown = performance.now();
        if (this.lastDown - this.previousDown < 300){
          this.conn.send(JSON.stringify({ type: "cardFlip", card: this.curDragging }));
        }
        if(this.cards[this.curDragging].selectedBy !== this.conn.id){
          this.conn.send(JSON.stringify({ type: "deselect" }));
        }
      }

      // This will move a single card, or multiple if multiple are selected
      this.conn.send(JSON.stringify({
        type: "cardAll",
        card: this.curDragging,
        movement: {
          x: event.movementX,
          y: event.movementY
        },
      }));
    } else {
      // Consider making a selection
      if (event.type === "pointerdown" && this.players[this.conn.id].selection === null) {
        this.conn.send(JSON.stringify({ type: "deselect" }));           // Deselect Existing Selection
        this.selectionStart = { x: event.pageX, y: event.pageY };       // Create the foundation for a new selection
      } else if (event.type === "pointermove" && this.selectionStart) {
        this.conn.send(JSON.stringify({ type: "selection", selection: { // Update the Selection Box
          x1: Math.min(this.selectionStart.x, event.pageX),
          y1: Math.min(this.selectionStart.y, event.pageY),
          x2: Math.max(this.selectionStart.x, event.pageX),
          y2: Math.max(this.selectionStart.y, event.pageY)
        } }));
      } else if (event.type === "pointerup" && this.selectionStart) {
        this.conn.send(JSON.stringify({ type: "endSelection" }));       // Finish selection
        this.selectionStart = null;                                     // Clear the selection foundation
      }
    }
  }

  start() {
    //this.add("Connected!");
    requestAnimationFrame(this.animationCallback);
  }

  /** @param {number} timeMS */
  updateOnClient(timeMS) {
    requestAnimationFrame(this.animationCallback);

    // Calculate the framerate-independent movement interpolation alpha
    // (This should really be done with a proper timeline interpolator, but I'm too lazy to write one again)
    if(!timeMS) { timeMS = performance.now(); }
    this.prevTime = this.time;
    this.time = timeMS / 1000.0;
    this.deltaTime = this.time - this.prevTime;
    let alpha = 1.0 - Math.exp(-25 * this.deltaTime);
    let alpha2 = 1.0 - Math.exp(-15 * this.deltaTime);

    // Interpolate the cards' render positions towards their actual positions
    for (let card in this.cards) {
      this.cards[card].renderPosition.x += (this.cards[card].position.x - this.cards[card].renderPosition.x) * alpha;
      this.cards[card].renderPosition.y += (this.cards[card].position.y - this.cards[card].renderPosition.y) * alpha;
      this.cards[card].element.style.transform = `translate(${this.cards[card].renderPosition.x - (238*0.4)}px,
                                                            ${this.cards[card].renderPosition.y - (332*0.4)}px)
                                                            rotate(${this.cards[card].rotation}deg) scale(0.4)`;
    }

    // Interpolate the players' render positions towards their actual positions
    for (let player in this.players) {
      this.players[player].renderPosition.x += (this.players[player].cursorPosition.x - this.players[player].renderPosition.x) * alpha;
      this.players[player].renderPosition.y += (this.players[player].cursorPosition.y - this.players[player].renderPosition.y) * alpha;
      this.players[player].element.style.transform = `translate3d(${this.players[player].renderPosition.x}px, ${this.players[player].renderPosition.y}px, 0px) rotateZ(${this.players[player].cursorPressed ? -20 : 0}deg)`;
      let vis = (player === this.conn.id || this.players[player].renderPosition.y > 400);
      this.players[player].element.classList.toggle("visible",!vis);
      this.players[player].element.classList.toggle( "hidden", vis);

      // Handle the selection box
      if (this.players[player].selection !== null && (player === this.conn.id || this.players[player].renderPosition.y < 400)) {
        this.players[player].renderSelection.x1 += (this.players[player].selection.x1 - this.players[player].renderSelection.x1) * alpha;
        this.players[player].renderSelection.y1 += (this.players[player].selection.y1 - this.players[player].renderSelection.y1) * alpha;
        this.players[player].renderSelection.x2 += (this.players[player].selection.x2 - this.players[player].renderSelection.x2) * alpha;
        this.players[player].renderSelection.y2 += (this.players[player].selection.y2 - this.players[player].renderSelection.y2) * alpha;

        this.players[player].selectionElement.style.width  = (this.players[player].renderSelection.x2 - this.players[player].renderSelection.x1) + "px";
        this.players[player].selectionElement.style.height = (this.players[player].renderSelection.y2 - this.players[player].renderSelection.y1) + "px";
        this.players[player].selectionElement.style.left   =  this.players[player].renderSelection.x1 + "px";
        this.players[player].selectionElement.style.top    =  this.players[player].renderSelection.y1 + "px";
        this.players[player].selectionElement.classList.toggle("visible", true);
        this.players[player].selectionElement.classList.toggle("hidden", !true);
      }else {
        this.players[player].selectionElement.classList.toggle("visible", false);
        this.players[player].selectionElement.classList.toggle("hidden", !false);
      }
    }


    // Create a friendly automatic sorting system for the Hand
    // Step 1: Create a list of cards in the hand
    let cardsInHand = [];
    for (let card in this.cards) {
      if (this.cards[card].visibleOnlyTo === this.conn.id) {
        cardsInHand.push(card);
      }
    }

    // Step 2: Create a sorting slot position for each card in the hand
    let slots = [];
    for (let i = 0; i < cardsInHand.length; i++) {
      slots.push({ x: 320 * (i / cardsInHand.length) + 30, y: 500 });
    }

    // Step 3: Apply the Jonker-Volgenant Algorithm to sort the cards in the hand to their slots
    let lapOut = lap(slots.length, /** @param {number} aInd @param {number} bInd */ (aInd, bInd)=>{
      let a = slots[aInd];
      let b = this.cards[cardsInHand[bInd]].position;
      let x = b.x - a.x; let y = b.y - a.y;
      return (x*x) + (y*y);
    });

    // Step 4: Gently lerp the cards to their new positions
    for(let i = 0; i < lapOut.col.length; i++){
      let card = cardsInHand[i];
      if(card !== this.curDragging && !(this.curDragging !== undefined && this.cards[card].selectedBy === this.conn.id)){
        let movementX = (slots[lapOut.col[i]].x - this.cards[card].position.x);
        let movementY = (slots[lapOut.col[i]].y - this.cards[card].position.y);
        if (Math.abs(movementX) > 0.1 || Math.abs(movementY) > 0.1){
          this.conn.send(JSON.stringify({
            type: "card",
            card: card,
            inHand: true,
            movement: { x: movementX * alpha2, y: movementY * alpha2 },
          }));
        } else if (Math.abs(movementX) > 0.01 || Math.abs(movementY) > 0.01) {
          // Set the cards to the correct position if they are close enough
          // This helps avoid visual artifacts from "almost" being in the right place
          this.conn.send(JSON.stringify({
            type: "card",
            card: card,
            inHand: false,
            movement: { x: movementX, y: movementY },
          }));
          this.cards[card].position.x += movementX;
          this.cards[card].position.y += movementY;
        }
      }
    }
  }

  /** @param {MessageEvent} event - The message event */
  updateFromServer(event) {
    /** @type {string} */
    let dataString = event.data;
    if (dataString.startsWith("{")) {
      let data = JSON.parse(dataString);
      if (data.type.includes("update")) {
        if(data.type === "fullupdate"){
          // Enumerate through the cards and the players, marking all dirty
          for (let   card in this.  cards) { this.  cards[  card].dirty = true; }
          for (let player in this.players) { this.players[player].dirty = true; }
        }

        // Enumerate through the cards, updating as necessary (and marking clean)
        for (let card in data.cards) {
          if (this.cards[card] === undefined) {
            this.cards[card] = data.cards[card];
            let selectionColor = (this.cards[card].selectedBy !== null) ? this.playersToColors[this.cards[card].selectedBy] : "black";
            let img = document.createElement("img");
            img.src = "./cards/BACK.jpg"; //"./cards/"+this.cards[card].suit+"-"+this.cards[card].value+".svg";
            img.style.position = "absolute";
            img.style.border = "10px solid "+selectionColor;
            img.style.borderRadius = "20px";
            img.style.transition = "opacity 100ms;";
            img.style.zIndex = ""+this.cards[card].zIndex;
            //console.log(card, "Z-Index: "+this.cards[card].zIndex, img.style.zIndex);
            document.body.prepend(img);

            img.addEventListener("pointerdown", (event) => {
              event.preventDefault(); //event.stopPropagation();
              this.curDragging = card;
            }, { passive: false });
            img.addEventListener("pointerup",(event) => {
              event.preventDefault(); //event.stopPropagation();
              this.curDragging = undefined;
            }, { passive: false });

            this.cards[card].element = img;
            this.cards[card].renderPosition = { x: this.cards[card].position.x, y: this.cards[card].position.y };
            
          } else {
            Object.assign(this.cards[card], data.cards[card]);
            //this.cards[card].element.style.transform = `translate(${this.cards[card].position.x - (238*0.25)}px, 
            //                                                      ${this.cards[card].position.y - (332*0.25)}px) 
            //                                                      rotate(${this.cards[card].rotation}deg) scale(0.5)`;
            let selectionColor = (this.cards[card].selectedBy !== null) ? this.playersToColors[this.cards[card].selectedBy] : "black";
            this.cards[card].element.style.zIndex = ""+this.cards[card].zIndex;
            let visible = (this.cards[card].visibleOnlyTo === "all" || this.cards[card].visibleOnlyTo === this.conn.id);
            this.cards[card].element.classList.toggle("visible", visible);
            this.cards[card].element.classList.toggle("hidden", !visible);
            //this.cards[card].element.style.opacity = (this.cards[card].visibleOnlyTo === "all" || this.cards[card].visibleOnlyTo === this.conn.id) ? "1.0" : "0.0";
            if (this.cards[card].visibleOnlyTo === "all"){
              this.cards[card].element.style.border = "10px solid "+selectionColor;
            }else{
              this.cards[card].element.style.border = "10px dashed "+selectionColor;
            }

            // Handle the flipping of the card
            if (this.cards[card].flipped && !this.cards[card].element.src.includes("BACK.jpg")){
              this.cards[card].element.src = "./cards/BACK.jpg";
            }else if (!this.cards[card].flipped && this.cards[card].element.src.includes("BACK.jpg")){
              this.cards[card].element.src = "./cards/"+this.cards[card].suit+"-"+this.cards[card].value+".svg";
            }
          }
          this.cards[card].dirty = false;
        }

        // Enumerate through the players, updating as necessary (and marking clean)
        for (let player in data.players) {
          if (this.players[player] === undefined) {
            this.players[player] = data.players[player];

            let img = document.createElement("img");
            img.src = "./cursor_small.png";
            img.style.position = "absolute";
            img.style.touchAction = "none";
            img.style.zIndex = ""+10000000;
            img.style.pointerEvents = "none";
            img.style.filter = "drop-shadow(0px 0px 3px "+this.players[player].color+")";
            this.playersToColors[this.players[player].id] = this.players[player].color;
            document.body.prepend(img);
            this.players[player].element = img;

            let selectionElem = document.createElement("div");
            selectionElem.style.position = "absolute";
            selectionElem.style.width = "0px";
            selectionElem.style.height = "0px";
            selectionElem.style.top = "0px";
            selectionElem.style.left = "0px";
            selectionElem.style.backgroundColor = "rgba(255, 255, 255, "+(this.players[player].id === this.conn.id ? 0.25 : 0.1)+")";
            selectionElem.style.border = "2px dashed "+this.players[player].color;
            selectionElem.style.borderRadius = "20px";
            selectionElem.style.zIndex = "100000000";
            selectionElem.style.pointerEvents = "none";
            document.body.prepend(selectionElem);
            this.players[player].selectionElement = selectionElem;

            this.players[player].renderPosition = { x: this.players[player].cursorPosition.x, y: this.players[player].cursorPosition.y };
            this.players[player].renderSelection = { x1: 0, y1: 0, x2: 0, y2: 0 };

            /** @type {HTMLDivElement | HTMLInputElement} */
            this.players[player].nametag = document.createElement(this.players[player].id === this.conn.id ? "input" : "div");
            this.players[player].nametag.style.position = "relative";
            this.players[player].nametag.style.width = "100%";
            this.players[player].nametag.style.height = "20px";
            this.players[player].nametag.style.color = this.players[player].color;
            this.players[player].nametag.style.backgroundColor = "rgba(255, 255, 255, "+(this.players[player].id === this.conn.id ? 0.6 : 0.4)+")";
            this.players[player].nametag.style.border = "2px solid black";
            this.players[player].nametag.style.borderRadius = "20px";
            this.players[player].nametag.style.zIndex = "0";
            this.players[player].nametag.style.textAlign = "center";
            this.players[player].nametag.style.verticalAlign = "middle";
            this.players[player].nametag.style.lineHeight = "20px";
            this.players[player].nametag.style.fontSize = "20px";
            if(this.players[player].id === this.conn.id){
              this.players[player].nametag.style.pointerEvents = "auto";
              this.players[player].nametag.value = this.players[player].name;
              this.players[player].nametag.addEventListener("input", (event) => {
                this.conn.send(JSON.stringify({ type: "name", name: this.players[player].nametag.value }));
              });
            }else{
              this.players[player].nametag.style.pointerEvents = "none";
              this.players[player].nametag.textContent = this.players[player].name;
            }
            this.playerList.appendChild(this.players[player].nametag);
          } else {
            let selectionDirty = this.players[player].selection === null;
            Object.assign(this.players[player], data.players[player]);
            if(selectionDirty && this.players[player].selection !== null){
              this.players[player].renderSelection.x1 = this.players[player].selection.x1;
              this.players[player].renderSelection.y1 = this.players[player].selection.y1;
              this.players[player].renderSelection.x2 = this.players[player].selection.x2;
              this.players[player].renderSelection.y2 = this.players[player].selection.y2;
            }

            // Render player name and number of cards in hand
            let numCardsInHand = 0;
            for(let card in this.cards){ if(this.cards[card].visibleOnlyTo === player){ numCardsInHand += 1; } }
            this.players[player].nametag.textContent = this.players[player].name+" - "+numCardsInHand;
            //this.players[player].element.style.transform = `translate3d(${this.players[player].cursorPosition.x}px, ${this.players[player].cursorPosition.y}px, 0px) rotateZ(${this.players[player].cursorPressed ? -10 : 0}deg)`;
          }
          this.players[player].dirty = false;
        }

        if(data.type === "fullupdate"){
          // Enumerate through the cards, removing any that are still dirty
          for (let card in this.cards) {
            if (this.cards[card].dirty) {
              this.cards[card].element.remove();
              delete this.cards[card];
            }
          }

          // Enumerate through the players, removing any that are still dirty
          for (let player in this.players) {
            if (this.players[player].dirty) {
              this.add(`Player ${this.players[player].name} has disconnected!`);
              this.players[player].element.remove();
              this.players[player].nametag.remove();
              this.players[player].selectionElement.remove();
              delete this.players[player];
            }
          }
        }
      }
    }else{
      this.add(`Received -> ${dataString}`);
    }
  }

  /** @param {string} text - The text to be added */
  add(text) {
    //this.output.appendChild(document.createTextNode("........."+text));
    //this.output.appendChild(document.createElement("br"));
  }
}

let game = new CardGame();
