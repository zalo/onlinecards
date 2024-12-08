/* eslint-env browser */
/* global PARTYKIT_HOST */

import "./styles.css";
import PartySocket from "partysocket";
import lap from "./lap.js";

class CardGame {
  constructor() {
    // Intercept Main Window Errors
    window.realConsoleError = console.error;
    window.addEventListener('error', (event) => {
        let path = event.filename.split("/");
        this.add((path[path.length - 1] + ":" + event.lineno + " - " + event.message));
    });
    console.error = this.fakeError.bind(this);


    /** @type {ReturnType<typeof setInterval>} */
    this.pingInterval;

    this.suits       = ["CLUB", "HEART", "DIAMOND", "SPADE"];
    this.values      = ["3", "4", "5", "6", "7", "8", "9", "10", "11-JACK", "12-QUEEN", "13-KING", "1", "2"];

    /** @type {HTMLDivElement} - The DOM element to append all messages we get */
    this.output = /** @type {HTMLDivElement} */ (document.body);//getElementById("app"));

    /** @type {Record<string, { suit: string, value: string, position: { x: number, y: number }, renderPosition: { x: number, y: number }, rotation: number, flipped: boolean, dirty: boolean, element: HTMLImageElement, visibleOnlyTo: string, zIndex: number }>} */
    this.cards   = {};
    /** @type {Record<string, { name: string, id:string, cursorPosition: { x: number, y: number }, renderPosition: { x: number, y: number }, cursorPressed: boolean, dirty: boolean, element: HTMLImageElement }>} */
    this.players = {};

    this.curDragging = undefined;

    /** @type {PartySocket} - The connection object */
    this.conn = new PartySocket({
      // @ts-expect-error This should be typed as a global string
      host: PARTYKIT_HOST,
      room: "card-game-global",
    });

    this.conn.addEventListener("open"   , this.start           .bind(this));
    this.conn.addEventListener("message", this.updateFromServer.bind(this));

    window.addEventListener("pointermove", this.sendMouseUpdate.bind(this));
    window.addEventListener("pointerdown", this.sendMouseUpdate.bind(this));
    window.addEventListener("pointerup"  , this.sendMouseUpdate.bind(this));

    this.animationCallback = this.updateOnClient.bind(this);

    document.body.style.backgroundImage = "url('./background.jpg')";
    document.body.style.backgroundRepeat = "repeat";

    this.hand = document.createElement("div");
    this.hand.style.position = "absolute";
    this.hand.style.width = "380px";
    this.hand.style.height = "200px";
    this.hand.style.top = "435px";
    this.hand.style.left = "0px";
    this.hand.style.backgroundColor = "rgba(255, 255, 255, 0.4)";
    this.hand.style.border = "10px solid black";
    this.hand.style.borderRadius = "20px";
    this.hand.style.zIndex = "0";
    this.hand.style.textAlign = "center";
    this.hand.style.verticalAlign = "middle";
    this.hand.style.lineHeight = "200px";
    this.hand.style.fontSize = "50px";
    this.hand.style.pointerEvents = "none";
    this.hand.textContent = "Your Hand";
    document.body.appendChild(this.hand);

    // Add a button to deal the player one card
    this.dealButton = document.createElement("button");
    this.dealButton.style.position = "absolute";
    this.dealButton.style.width = "170px";
    this.dealButton.style.height = "50px";
    this.dealButton.style.top = "0px";
    this.dealButton.style.left = "200px";
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
      // Select a random card that is in the top left corner of the screen
      let maxZIndex = -1;
      let topCard = undefined;
      for(let card in this.cards){
        if(this.cards[card].position.x < 25 && this.cards[card].position.y < 35 && this.cards[card].zIndex > maxZIndex){
          maxZIndex = this.cards[card].zIndex;
          topCard = card;
        }
      }
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
          //this.cards[this.curDragging].flipped = !this.cards[this.curDragging].flipped;
          this.conn.send(JSON.stringify({
            type: "cardFlip",
            card: this.curDragging
          }));
          console.log("Flipped card: "+this.curDragging);
        }
      }

      this.conn.send(JSON.stringify({
        type: "card",
        card: this.curDragging,
        movement: {
          x: event.movementX,
          y: event.movementY,
        },
      }));
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
      this.players[player].element.style.visibility = (player === this.conn.id || this.players[player].renderPosition.y > 400) ? "hidden" : "visible";
    
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
      if(card !== this.curDragging){
        let movementX = (slots[lapOut.col[i]].x - this.cards[card].position.x) * alpha2;
        let movementY = (slots[lapOut.col[i]].y - this.cards[card].position.y) * alpha2;
        if (Math.abs(movementX) > 0.1 || Math.abs(movementY) > 0.1 || this.cards[card].zIndex !== 10000 + lapOut.col[i]) {
          this.conn.send(JSON.stringify({
            type: "card",
            card: card,
            zIndex: 10000 + lapOut.col[i],
            movement: {
              x: movementX,
              y: movementY,
            },
          }));
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
      if (data.type === "fullupdate") {
        // Enumerate through the cards and the players, marking all dirty
        for (let   card in this.  cards) { this.  cards[  card].dirty = true; }
        for (let player in this.players) { this.players[player].dirty = true; }

        // Enumerate through the cards, updating as necessary (and marking clean)
        for (let card in data.cards) {
          if (this.cards[card] === undefined) {
            this.cards[card] = data.cards[card];
            let img = document.createElement("img");
            img.src = "./cards/BACK.jpg"; //"./cards/"+this.cards[card].suit+"-"+this.cards[card].value+".svg";
            img.style.position = "absolute";
            img.style.border = "10px solid black";
            img.style.borderRadius = "20px";
            img.style.transition = "opacity 100ms;";
            img.style.zIndex = ""+this.cards[card].zIndex;
            console.log(card, "Z-Index: "+this.cards[card].zIndex, img.style.zIndex);
            document.body.prepend(img);

            img.addEventListener("pointerdown", (event) => {
              event.preventDefault(); //event.stopPropagation();
              this.curDragging = card;
            }, { passive: false });
            img.addEventListener("pointerup",(event) => {
              event.preventDefault(); //event.stopPropagation();
              this.curDragging = undefined;
            }, { passive: false });
            //img.addEventListener("dblclick", (event) => {
            //  event.preventDefault(); //event.stopPropagation();
            //  this.cards[card].flipped = !this.cards[card].flipped;
            //  this.conn.send(JSON.stringify({
            //    type: "cardFlip",
            //    card: card
            //  }));
            //  console.log("Flipped card: "+card);
            //}, { passive: false });

            this.cards[card].element = img;
            this.cards[card].renderPosition = { x: this.cards[card].position.x, y: this.cards[card].position.y };
          } else {
            Object.assign(this.cards[card], data.cards[card]);
            //this.cards[card].element.style.transform = `translate(${this.cards[card].position.x - (238*0.25)}px, 
            //                                                      ${this.cards[card].position.y - (332*0.25)}px) 
            //                                                      rotate(${this.cards[card].rotation}deg) scale(0.5)`;
            this.cards[card].element.style.zIndex = ""+this.cards[card].zIndex;
            let visible = (this.cards[card].visibleOnlyTo === "all" || this.cards[card].visibleOnlyTo === this.conn.id);
            this.cards[card].element.classList.toggle("visible", visible);
            this.cards[card].element.classList.toggle("hidden", !visible);
            //this.cards[card].element.style.opacity = (this.cards[card].visibleOnlyTo === "all" || this.cards[card].visibleOnlyTo === this.conn.id) ? "1.0" : "0.0";
            if (this.cards[card].visibleOnlyTo === "all"){
              this.cards[card].element.style.border = "10px solid black";
            }else{
              this.cards[card].element.style.border = "10px dashed gray";
            }

            // Handle the flipping of the card
            if (this.cards[card].flipped){//} && !this.cards[card].element.src.includes("BACK.jpg")){
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
            document.body.prepend(img);
            this.players[player].element = img;
            this.players[player].renderPosition = { x: this.players[player].cursorPosition.x, y: this.players[player].cursorPosition.y };
          } else {
            Object.assign(this.players[player], data.players[player]);
            //this.players[player].element.style.transform = `translate3d(${this.players[player].cursorPosition.x}px, ${this.players[player].cursorPosition.y}px, 0px) rotateZ(${this.players[player].cursorPressed ? -10 : 0}deg)`;
          }
          this.players[player].dirty = false;
        }

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
            delete this.players[player];
          }
        }
      }
    }else{
      this.add(`Received -> ${dataString}`);
    }
  }

  /** @param {string} text - The text to be added */
  add(text) {
    this.output.appendChild(document.createTextNode("........."+text));
    this.output.appendChild(document.createElement("br"));
  }

  // Log Errors as <div>s over the main viewport
  fakeError(...args) {
    if (args.length > 0 && args[0]) { this.add(JSON.stringify(args[0])); }
    window.realConsoleError.apply(console, arguments);
  }
}

let game = new CardGame();
