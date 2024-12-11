/* eslint-env browser */

// @ts-check
// Optional JS type checking, powered by TypeScript.
/** @typedef {import("partykit/server").Room} Room */
/** @typedef {import("partykit/server").Server} Server */
/** @typedef {import("partykit/server").Connection} Connection */
/** @typedef {import("partykit/server").ConnectionContext} ConnectionContext */

/** @implements {Server} */
class PartyServer {
  /** @param {Room} room */
  constructor(room) {
    this.suits  = ["CLUB", "SPADE", "HEART", "DIAMOND"];
    this.values = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "11-JACK", "12-QUEEN", "13-KING", "1"];

    /** @type {Room} */
    this.room = room;

    /** @type {Record<string, { name: string, id:string, cursorPosition: { x: number, y: number }, cursorPressed: boolean, selection: {x1: number, y1: number, x2: number, y2: number} | null}>} */
    this.players = {};
    this.globalPlayerCount = 0;
    this.highestzIndex = 10000;

    /** @type {Record<string, { suit: string, value: string, position: { x: number, y: number }, rotation: number, flipped: boolean, visibleOnlyTo: string, selectedBy: string | null, zIndex: number }>} */
    this.cards = {};
    for(let suitInd = 0; suitInd < this.suits.length; suitInd++){
      for(let valueInd = 0; valueInd < this.values.length; valueInd++){
        this.cards[this.suits[suitInd]+"="+this.values[valueInd]] = {
          suit: this.suits[suitInd], 
          value: this.values[valueInd],
          position: { x: 20, y: 30 },
          rotation: 0,
          flipped: true,
          visibleOnlyTo: "all",
          selectedBy: null,
          zIndex: Math.floor(Math.random() * 10000),
        };
      }
    }

    // This co
    this.hasNewInfoToSend = false;
    this.interval = setInterval(() => {
      if(!this.hasNewInfoToSend) return;
      this.room.broadcast(JSON.stringify({
        type: "fullupdate",
        players: this.players,
        cards: this.cards,
      }));
      this.hasNewInfoToSend = false;
    }, 1000/30);
  }

  /**
   * @param {Connection} conn - The connection object.
   * @param {ConnectionContext} ctx - The context object. */
  onConnect(conn, ctx) {
    console.log(
      `Connected:
       id: ${conn.id}
       room: ${this.room.id}
       url: ${new URL(ctx.request.url).pathname}`
    );

    // Add the player to the list of players
    this.globalPlayerCount += 1;
    this.players[conn.id] = {
      name: "Player " + this.globalPlayerCount,
      id: conn.id,
      cursorPosition: { x: 0, y: 0 },
      cursorPressed: false,
      selection: null,
    };

    // Send an update message to all the connections
    this.room.broadcast(JSON.stringify({
      type: "fullupdate",
      players: this.players,
      cards: this.cards,
    }));
  }

  /**
   * @param {string} message
   * @param {Connection} sender */
  onMessage(message, sender) {
    //console.log(`connection ${sender.id} sent message: ${message}`);

    if(message.startsWith("{")){
      let data = JSON.parse(message);
      if(data.type === "cursor"){
        this.players[sender.id].cursorPosition.x = data.cursorPosition.x;
        this.players[sender.id].cursorPosition.y = data.cursorPosition.y;
        this.players[sender.id].cursorPressed    = data.cursorPressed;
      } else if(data.type === "selection"){
        this.players[sender.id].selection = data.selection;
        if(data.selection !== null){
          for(let card in this.cards){
            if(this.cards[card].position.x > data.selection.x1 && 
               this.cards[card].position.x < data.selection.x2 && 
               this.cards[card].position.y > data.selection.y1 && 
               this.cards[card].position.y < data.selection.y2){
              if(this.cards[card].selectedBy === null && 
                 (this.cards[card].visibleOnlyTo === "all" || 
                  this.cards[card].visibleOnlyTo === sender.id)){
                this.cards[card].selectedBy = sender.id;
              }
            } else if (this.cards[card].selectedBy === sender.id) {
              this.cards[card].selectedBy = null;
            }
          }
        }
      } else if(data.type === "endSelection"){
        this.players[sender.id].selection = null;
      } else if(data.type === "deselect"){
        for(let card in this.cards){
          if (this.cards[card].selectedBy === sender.id) {
            this.cards[card].selectedBy = null;
          }
        }
      } else if(data.type === "cardFlip"){
        let destinationFlip = !this.cards[data.card].flipped;
        if(this.cards[data.card].selectedBy === sender.id){
          for(let card in this.cards){
            if (this.cards[card].selectedBy === sender.id) {
              this.cards[card].flipped = destinationFlip;
            }
          }
        }else{
          this.cards[data.card].flipped = destinationFlip;
        }
      } else if(data.type.startsWith("card")){
        // Get a list of the cards selected by this conn
        let selectedCards = [];
        if(this.cards[data.card].selectedBy === sender.id && data.type === "cardAll"){
          for(let card in this.cards){ 
            if(this.cards[card].selectedBy === sender.id){
               selectedCards.push(card);
            }
          }
        } else {
          selectedCards = [data.card];
        }

        for(let i = 0; i < selectedCards.length; i++){
          // Move and Clamp the position of the card
          this.cards[selectedCards[i]].position.x += data.movement.x;
          this.cards[selectedCards[i]].position.y += data.movement.y;
          this.cards[selectedCards[i]].position.x  = Math.max(0, Math.min(380, this.cards[selectedCards[i]].position.x));
          this.cards[selectedCards[i]].position.y  = Math.max(0, Math.min(500, this.cards[selectedCards[i]].position.y));

          if(this.cards[selectedCards[i]].position.y < 350){
            this.cards[selectedCards[i]].visibleOnlyTo = "all";
          } else {
            // This moving player is taking ownership of the card and hiding it in his hand
            if (this.cards[selectedCards[i]].visibleOnlyTo === "all"){
              this.cards[selectedCards[i]].visibleOnlyTo = sender.id;
            }
          }
          //this.cards[ownedCards[i]].rotation    = data.rotation;  // Unused so far
        }

        // For the rest of the cards, sort them by zIndex, and reassign their zIndex in that order + this.highestzIndex
        let tableCards = [];
        for(let card in this.cards){ 
          if(card == data.card ||
            (this.cards[card].selectedBy    === sender.id &&
             this.cards[card].visibleOnlyTo === "all")) { tableCards.push(card); } }
        tableCards.sort((a, b) => { return this.cards[a].zIndex - this.cards[b].zIndex; });
        for(let i = 0; i < tableCards.length; i++){ this.cards[tableCards[i]].zIndex = this.highestzIndex + i;}
        this.highestzIndex += 52;///tableCards.length;

        // Sort the cards from left to right and assign their zIndex in that order
        let handCards = [];
        for(let card in this.cards){ if(this.cards[card].visibleOnlyTo === sender.id) { handCards.push(card); } }
        handCards.sort((a, b) => { return this.cards[a].position.x - this.cards[b].position.x; });
        for(let i = 0; i < handCards.length; i++){
           this.cards[handCards[i]].zIndex = 100000000+i;
        }
      } else if(data.type === "name"){
        this.players[sender.id].name             = data.name;
      }else if(data.type === "chat"){
        this.room.broadcast(JSON.stringify({
          type: "chat",
          sender: sender.id,
          message: data.message,
        }));
      } else if(data.type === "reset"){
        // Release all cards that were being held by the player back to the deck in the corner
        for(let card in this.cards){
          this.cards[card].visibleOnlyTo = "all";
          this.cards[card].position.x = 20;
          this.cards[card].position.y = 30;
          this.cards[card].zIndex = Math.floor(Math.random() * 10000);
          this.cards[card].rotation = 0;
          this.cards[card].flipped = true;
          this.cards[card].selectedBy = null;
        }
      } else if(data.type.includes("sort")){
        // Sorts all of the cards in a players hand according to its value
        let handCards = []; let originalX = [];
        for(let card in this.cards){ if(this.cards[card].visibleOnlyTo === sender.id){ handCards.push(card); originalX.push(this.cards[card].position.x); } }
        originalX.sort((a, b) => { return a - b; });

        if(data.type === "sortSuit"){
          handCards.sort((a, b) => {
            let big   = Math.sign(this.suits.indexOf(this.cards[b]. suit) - this.suits .indexOf(this.cards[a].suit ))*20;
            let small = Math.sign(this.values.indexOf(this.cards[b].value) - this.values.indexOf(this.cards[a].value));
            return Math.sign(big+small); });
        } else if(data.type === "sortRank"){
          handCards.sort((a, b) => {
            let big   = Math.sign((this.values.indexOf(this.cards[b].value) - this.values .indexOf(this.cards[a].value)))*20;
            let small = Math.sign(this.suits.indexOf(this.cards[b].suit ) - this.suits.indexOf(this.cards[a].suit ));
            return Math.sign(big+small); });
        }

        for(let i = 0; i < handCards.length; i++){
           this.cards[handCards[i]].position.x = originalX[i];
           this.cards[handCards[i]].position.y = 495;
        }
      } else {
        console.error("Unknown message type: " + message);
      }
    }

    //// Broadcast the received message to all other connections in the room except the sender
    //this.room.broadcast(`${sender.id}: ${message}`, [sender.id]);

    // Send an update message to all the connections
    // TODO: Only send this at 15hz or so many active players don't exponentially increase outgoing bandwidth
    //this.room.broadcast(JSON.stringify({
    //  type: "fullupdate",
    //  players: this.players,
    //  cards: this.cards,
    //}));
    this.hasNewInfoToSend = true;
  }

  /** @param {Connection} conn - The connection object. */
  onDisconnect(conn){
    // Release all cards that were being held by the player back to the deck in the corner
    for(let card in this.cards){
      if(this.cards[card].visibleOnlyTo === conn.id){
        this.cards[card].visibleOnlyTo = "all";
        this.cards[card].position.x = 20;
        this.cards[card].position.y = 30;
        this.cards[card].zIndex = Math.floor(Math.random() * 10000);
        this.cards[card].rotation = 0;
        this.cards[card].flipped = true;
        this.cards[card].selectedBy = null;
      }
      if (this.cards[card].selectedBy === conn.id) {
        this.cards[card].selectedBy = null;
      }
    }

    // Remove the player from the list of players
    delete this.players[conn.id];

    // Send an update message to all the connections
    this.room.broadcast(JSON.stringify({
      type: "fullupdate",
      players: this.players,
      cards: this.cards,
    }));
  }

  /** @param {Connection} conn - The connection object. */
  onClose(conn){ this.onDisconnect(conn); }
  /**
   * @param {Connection} conn - The connection object.
   * @param {Error} error - The error object. */
  onError(conn, error){ console.error(error); this.onDisconnect(conn); }
}

export default PartyServer;
