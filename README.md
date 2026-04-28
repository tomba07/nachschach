# Nachschach

Nachschach is a small browser-based chess analysis board. Paste a PGN or FEN,
load the position, and step through the game with a local Stockfish engine
running in the browser.

The goal is not to clone a full chess server review, but to make quick
post-game analysis feel calm, local, and easy to inspect.

## Try It

Open the hosted version:

```text
https://tomba07.github.io/nachschach/
```

## Features

- Load full games from PGN or single positions from FEN
- Step through moves with buttons or keyboard arrows
- Run browser-local Stockfish analysis
- Show a live eval bar and centipawn score
- Mark moves as brilliant, excellent, good, inaccurate, mistake, or blunder
- Toggle a best-move arrow
- Flip the board
- Switch between light and dark themes

## Run Locally

This app is static, but it should be served from localhost because it uses ES
modules and a web worker.

```sh
cd /Users/mirkoteschke/Dev/nachschach
python3 -m http.server 8000
```

Then open:

```text
http://localhost:8000/
```

## How To Use

1. Wait for the engine to finish loading.
2. Paste a PGN or FEN into the input area.
3. Click `Load`.
4. Navigate with the move buttons, the move list, or arrow keys.
5. Toggle `Best Move` to show Stockfish's suggested move for the current
   position.

Keyboard shortcuts:

- `ArrowLeft`: previous move
- `ArrowRight`: next move
- `ArrowUp`: start of game
- `ArrowDown`: end of game
- `Cmd+Enter` / `Ctrl+Enter`: load the current input

## Analysis Notes

Nachschach uses Stockfish in the browser at a fixed search depth. Its results can
differ from Chess.com, Lichess, or other analysis tools because those services
may use different engine versions, depths, cloud analysis, tablebases, or move
classification models.

Move ratings are based on the mover's win-probability loss between consecutive
positions. The opening phase is intentionally a bit more forgiving, since raw
centipawn swings early in a game can make normal developing moves look worse
than they are.

## Project Structure

```text
index.html          App markup and script/style loading
style.css           Theme, layout, board, and move-list styling
app.js              PGN/FEN loading, Stockfish queue, UI state, move ratings
stockfish.wasm      Stockfish engine binary
stockfish.wasm.js   Stockfish worker wrapper
```

## Development

There is no build step right now. Edit the files directly and refresh the
browser.

For a quick JavaScript syntax check:

```sh
node --check app.js
```
