# 🃏 [onlinecards](https://onlinecards.zalo.partykit.dev)

A barebones interface attempting to replicate some of the flexibility of Tabletop Simulator on the web (in a mobile-friendly formfactor).

### TODO:
    - Add Discord Activity Integration
    - Polish up the UI for different screen formfactors
    - Add card rotation and more physically based movement (throwing?)
    - Auto-publish via Github Action?
    - Add More Games? (Palace?  One-Night Ultimate Werewolf?)

This is a [Partykit](https://partykit.io) project, which lets you create real-time collaborative applications with minimal coding effort.

[`server.js`](./src/server.js) is the server-side code, which is responsible for handling WebSocket events and HTTP requests. [`client.jsx`](./src/client.jsx) is the client-side code, which connects to the server and listens for events.

You can start developing by running `npm run dev` and opening [http://localhost:1999](http://localhost:1999) in your browser. When you're ready, you can deploy your application on to the PartyKit cloud with `npm run deploy`.

Refer to our docs for more information: https://github.com/partykit/partykit/blob/main/README.md. For more help, reach out to us on [Discord](https://discord.gg/g5uqHQJc3z), [GitHub](https://github.com/partykit/partykit), or [Twitter](https://twitter.com/partykit_io).
