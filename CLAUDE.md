# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Multiplayer card game table built on [PartyKit](https://partykit.io/). Players connect via WebSocket to shared rooms and can drag, flip, deal, and sort cards on a virtual table. Optimized for mobile touch input.

Live at: https://onlinecards.zalo.partykit.dev

## Commands

- `npm run dev` — Start dev server with live reload (PartyKit dev mode)
- `npm run deploy` — Deploy to PartyKit cloud

No test runner or linter is configured.

## Architecture

Client-server model over WebSockets. Three source files carry all logic:

- **`src/server.js`** — `PartyServer` class. Owns authoritative game state (deck, players, card positions/visibility). Broadcasts at 30Hz with a hybrid update strategy: full state every 30 frames, partial (dirty-flagged) updates otherwise. Handles all message types from clients.
- **`src/client.js`** — `CardGame` class. Renders cards/cursors/UI as DOM elements on a fixed 380×500 viewport. Manages pointer input (drag, double-tap flip, selection box). Interpolates positions with exponential decay smoothing. Sends cursor/card/selection messages to server.
- **`src/lap.js`** — Jonker-Volgenant Linear Assignment Problem solver. Used to optimally sort cards in a player's hand, minimizing total movement distance.

## Networking Protocol

Messages from client to server: `cursor`, `selection`, `endSelection`, `deselect`, `cardFlip`, `card`, `cardAll`, `name`, `chat`, `reset`, `sortSuit`, `sortRank`.

Server broadcasts: `fullupdate` (complete state) and `partialupdate` (only entities with `needsUpdate` flag set).

Room isolation via `?room=<id>` query parameter (defaults to "global").

## Key Concepts

- **Card visibility**: Cards dragged below y=350 become private to that player (`visibleOnlyTo` field). Above that threshold, cards are visible to all.
- **Partial updates**: Each player and card has a `needsUpdate` boolean. Only dirty entities are included in partial broadcasts. Full updates reset all flags.
- **Type checking**: JavaScript with JSDoc annotations and `@ts-check`. TypeScript strict mode is enabled in `tsconfig.json` with `checkJs: true` — no `.ts` files, but type errors are caught.
- **Card images**: SVG files in `public/cards/`, named by suit and value (e.g., `HEART-10.svg`, `CLUB-1.svg` for ace).

## Planned Work (from README)

- Refactor monolithic client/server files
- Discord Activity integration
- Card rotation and physics-based movement
- Auto-publish via GitHub Actions
- Additional games (Palace, One-Night Ultimate Werewolf)
