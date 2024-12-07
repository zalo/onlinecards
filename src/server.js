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
    this.suits  = ["CLUB", "HEART", "DIAMOND", "SPADE"];
    this.values = ["3", "4", "5", "6", "7", "8", "9", "10", "11-JACK", "12-QUEEN", "13-KING", "1", "2"];

    /** @type {Room} */
    this.room = room;

    /** @type {Record<string, { name: string, id:string, cursorPosition: { x: number, y: number }, cursorPressed: boolean }>} */
    this.players = {};
    this.globalPlayerCount = 0;
    this.highestzIndex = 10000;

    /** @type {Record<string, { suit: string, value: string, position: { x: number, y: number }, rotation: number, flipped: boolean, visibleOnlyTo: string, zIndex: number }>} */
    this.cards = {};
    for(let suitInd = 0; suitInd < this.suits.length; suitInd++){
      for(let valueInd = 0; valueInd < this.values.length; valueInd++){
        this.cards[this.suits[suitInd]+"="+this.values[valueInd]] = {
          suit: this.suits[suitInd], 
          value: this.values[valueInd],
          position: { x: 0, y: 0 },
          rotation: 0,
          flipped: true,
          visibleOnlyTo: "all",
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
    }, 1000/240);
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
      } else if(data.type === "cardFlip"){
        this.cards[data.card].flipped = !this.cards[data.card].flipped;
      } else if(data.type === "card"){
        this.cards[data.card].position.x += data.movement.x;
        this.cards[data.card].position.y += data.movement.y;
        // Clamp the position of the card
        this.cards[data.card].position.x = Math.max(0, Math.min(400, this.cards[data.card].position.x));
        this.cards[data.card].position.y = Math.max(0, Math.min(500, this.cards[data.card].position.y));

        if(this.cards[data.card].position.y < 300){
          this.cards[data.card].visibleOnlyTo = "all";
        } else {
          // This moving player is taking ownership of the card and hiding it in his hand
          if (this.cards[data.card].visibleOnlyTo === "all"){
            this.cards[data.card].visibleOnlyTo = sender.id;
          }
        }

        //this.cards[data.card].rotation    = data.rotation;
        //this.cards[data.card].flipped     = data.flipped;
        this.cards[data.card].zIndex     = this.highestzIndex;
        this.highestzIndex += 1;
      //} else if(data.type === "cardAnchor"){
      //  this.cards[data.card].anchors[sender.id] = {
      //    localAnchor: data.localAnchor,
      //    worldTarget: data.worldTarget,
      //  };
      //  // Compute the average position of all the anchors
      //  this.cards[data.card].position           = data.worldTarget;
      //  this.cards[data.card].rotation           = data.rotation;
      //  this.cards[data.card].flipped            = data.flipped;
      //  this.cards[data.card].zIndex            = this.highestzIndex;
      //  this.highestzIndex += 1;
      } else if(data.type === "name"){
        this.players[sender.id].name             = data.name;
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
        this.cards[card].position.x = 0.0;
        this.cards[card].position.y = 0.0;
        this.cards[card].zIndex = -10000;
        this.cards[card].rotation = 0;
        this.cards[card].flipped = true;
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
