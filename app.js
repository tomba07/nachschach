import { Chess } from 'https://cdn.jsdelivr.net/npm/chess.js@1.0.0-beta.6/dist/esm/chess.js';
import { Chessboard, COLOR } from 'https://cdn.jsdelivr.net/npm/cm-chessboard@8.12.7/src/Chessboard.js';
import { Arrows, ARROW_TYPE } from 'https://cdn.jsdelivr.net/npm/cm-chessboard@8.12.7/src/extensions/arrows/Arrows.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const CDN_ASSETS  = 'https://cdn.jsdelivr.net/npm/cm-chessboard@8.12.7/assets/';
const PIECES_FILE = 'https://cdn.jsdelivr.net/npm/cm-chessboard@8.12.7/assets/pieces/staunty.svg';
const ARROWS_SPRITE = 'https://cdn.jsdelivr.net/npm/cm-chessboard@8.12.7/assets/extensions/arrows/arrows.svg';
const ANALYSIS_DEPTH = 18;
const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

// ─── State ────────────────────────────────────────────────────────────────────

const state = {
  positions: [],            // [{fen, san, lan, cp, bestMove, classification}]
  currentIndex: 0,
  engine: null,
  engineReady: false,
  engineBusy: false,
  analysisQueue: [],
  currentAnalysisIndex: null,
  lastInfo: null,
  board: null,
  orientation: COLOR.white,
  showBestMove: false,
};

function createPosition(fen, move = {}) {
  return {
    fen,
    san: move.san || null,
    lan: move.lan || null,
    cp: null,
    bestMove: null,
    classification: null,
  };
}

// ─── PGN / FEN Parsing ────────────────────────────────────────────────────────

function isFen(text) {
  return /^[rnbqkpRNBQKP1-8/]+ [wb]/.test(text.trim());
}

function loadPgn(pgnText) {
  const chess = new Chess();
  chess.loadPgn(pgnText.trim()); // throws on invalid PGN

  const history = chess.history({ verbose: true });
  const replay  = new Chess();

  const positions = [createPosition(replay.fen())];

  for (const move of history) {
    replay.move(move.san);
    positions.push(createPosition(replay.fen(), {
      san: move.san,
      lan: move.from + move.to + (move.promotion || ''),
    }));
  }

  return positions;
}

function loadFen(fenText) {
  const chess = new Chess(fenText.trim());
  return [createPosition(chess.fen())];
}

// ─── Stockfish Engine ─────────────────────────────────────────────────────────

function initEngine() {
  const sf = new Worker('./stockfish.wasm.js');
  state.engine = sf;

  sf.onmessage = (e) => onEngineMessage(e.data);
  sf.onerror   = (e) => console.error('Stockfish error:', e);

  sf.postMessage('uci');
}

function onEngineMessage(line) {
  if (line === 'uciok') {
    state.engine.postMessage('setoption name Hash value 128');
    state.engine.postMessage('isready');
    return;
  }

  if (line === 'readyok') {
    state.engineReady = true;
    setEngineStatus('ready');
    processQueue();
    return;
  }

  if (line.startsWith('info') && line.includes('score') && line.includes(' pv ')) {
    state.lastInfo = parseInfoLine(line);
    return;
  }

  if (line.startsWith('bestmove')) {
    const parts = line.split(' ');
    const bestMove = parts[1];
    onAnalysisComplete(bestMove);
  }
}

function parseInfoLine(line) {
  const cpMatch   = line.match(/score cp (-?\d+)/);
  const mateMatch = line.match(/score mate (-?\d+)/);
  const pvMatch   = line.match(/ pv ([a-h][1-8][a-h][1-8]\S*)/);

  let cp = null;
  if (cpMatch)   cp = parseInt(cpMatch[1], 10);
  if (mateMatch) cp = parseInt(mateMatch[1], 10) > 0 ? 99999 : -99999;

  return {
    cp,
    bestMoveLan: pvMatch ? pvMatch[1] : null,
  };
}

// Stockfish cp is side-to-move relative. Normalize to always-white perspective.
function normalizeCp(cp, fen) {
  return fen.includes(' b ') ? -cp : cp;
}

// ─── Analysis Queue ───────────────────────────────────────────────────────────

function enqueueAll() {
  state.analysisQueue = [];
  for (let i = 0; i < state.positions.length; i++) {
    state.analysisQueue.push(i);
  }
}

// Prioritize current position + next 2 (look-ahead) so they're ready before
// the user steps there. Positions are spliced to the front in reverse priority
// order so current ends up first.
function prioritizeAhead() {
  const lookahead = [
    state.currentIndex + 2,
    state.currentIndex + 1,
    state.currentIndex,
  ].filter(i => i >= 0 && i < state.positions.length && state.positions[i].cp === null);

  if (lookahead.length === 0) return;
  state.analysisQueue = state.analysisQueue.filter(i => !lookahead.includes(i));
  state.analysisQueue.unshift(...lookahead);
}

function processQueue() {
  if (!state.engineReady || state.engineBusy) return;
  if (state.analysisQueue.length === 0) return;

  const index = state.analysisQueue.shift();
  if (state.positions[index].cp !== null) {
    processQueue();
    return;
  }

  state.engineBusy = true;
  state.currentAnalysisIndex = index;
  state.lastInfo = null;

  const fen = state.positions[index].fen;
  state.engine.postMessage('stop');
  state.engine.postMessage(`position fen ${fen}`);
  state.engine.postMessage(`go depth ${ANALYSIS_DEPTH}`);

  updateThinkingIndicator();
}

function onAnalysisComplete(bestMoveLan) {
  const index = state.currentAnalysisIndex;
  if (index === null) return;

  const pos  = state.positions[index];
  const info = state.lastInfo || {};

  // Normalize to white perspective
  const rawCp = info.cp !== null && info.cp !== undefined ? info.cp : 0;
  pos.cp       = normalizeCp(rawCp, pos.fen);
  pos.bestMove = info.bestMoveLan || bestMoveLan;

  // Classify the move that led to this position (index > 0)
  if (index > 0 && state.positions[index - 1].cp !== null) {
    classifyMove(index);
  }
  // If this is position 0 (start), try to classify position 1 if its cp is known
  if (index === 0 && state.positions.length > 1 && state.positions[1].cp !== null) {
    classifyMove(1);
  }

  state.engineBusy = false;
  state.currentAnalysisIndex = null;

  // Update UI if this is the position currently on screen
  if (index === state.currentIndex) {
    renderEvalBar(pos.cp);
    if (state.showBestMove) renderBestMoveArrow(pos.bestMove);
    updateThinkingIndicator();
  }

  updateMoveListBadge(index);
  processQueue();
}

// ─── Move Classification ──────────────────────────────────────────────────────

function classifyMove(index) {
  const prev = state.positions[index - 1];
  const curr = state.positions[index];

  if (prev.cp === null || curr.cp === null) return;

  // Both cp values are white-normalized (positive = white advantage).
  // From the mover's perspective: how many cp did THEY lose?
  const whiteToMove = prev.fen.includes(' w ');
  // moverLoss > 0 means their side got weaker; < 0 means they improved position
  const moverLoss = whiteToMove ? (prev.cp - curr.cp) : (curr.cp - prev.cp);

  let classification;
  if      (moverLoss < -50)  classification = 'brilliant';
  else if (moverLoss <=  0)  classification = 'excellent';
  else if (moverLoss <= 20)  classification = 'good';
  else if (moverLoss <= 50)  classification = 'inaccuracy';
  else if (moverLoss <= 150) classification = 'mistake';
  else                       classification = 'blunder';

  curr.classification = classification;
}

// ─── Eval Bar ─────────────────────────────────────────────────────────────────

function winProb(cp) {
  return 1 / (1 + Math.exp(-cp / 400));
}

function renderEvalBar(cp) {
  setEvalLoading(false);
  const whitePct = winProb(cp) * 100;
  const blackPct = 100 - whitePct;

  document.getElementById('eval-bar-white').style.height = whitePct + '%';
  document.getElementById('eval-bar-black').style.height = blackPct + '%';

  let label;
  if (Math.abs(cp) >= 99999) {
    label = cp > 0 ? '+M' : '-M';
  } else {
    const pawns = (Math.abs(cp) / 100).toFixed(1);
    label = cp >= 0 ? `+${pawns}` : `-${pawns}`;
  }
  document.getElementById('eval-score').textContent = label;
}

function resetEvalBar() {
  document.getElementById('eval-bar-white').style.height = '50%';
  document.getElementById('eval-bar-black').style.height = '50%';
  document.getElementById('eval-score').textContent = '…';
  setEvalLoading(true);
}

function setEvalLoading(on) {
  document.getElementById('eval-bar').classList.toggle('loading', on);
  document.getElementById('eval-score').classList.toggle('loading', on);
}

// ─── Board ────────────────────────────────────────────────────────────────────

function initBoard() {
  state.board = new Chessboard(document.getElementById('board'), {
    position:    START_FEN,
    orientation: COLOR.white,
    assetsUrl:   CDN_ASSETS,
    style: {
      pieces: { file: PIECES_FILE },
    },
    extensions: [{
      class: Arrows,
      props: { sprite: ARROWS_SPRITE, slice: 'arrowDefault', headSize: 4 },
    }],
  });

  // Sync eval bar height to board height
  const observer = new ResizeObserver(() => {
    const h = document.getElementById('board-container').offsetHeight;
    if (h > 0) document.getElementById('eval-bar').style.height = h + 'px';
  });
  observer.observe(document.getElementById('board-container'));
}

function navigateTo(index) {
  if (index < 0 || index >= state.positions.length) return;
  state.currentIndex = index;

  const pos = state.positions[index];
  state.board.setPosition(pos.fen, true);

  // Best-move arrow
  state.board.removeArrows();
  if (pos.bestMove && state.showBestMove) {
    renderBestMoveArrow(pos.bestMove);
  }

  // Eval bar
  if (pos.cp !== null) {
    renderEvalBar(pos.cp);
  } else {
    resetEvalBar();
  }

  // Always re-prioritize look-ahead on every navigation
  prioritizeAhead();
  processQueue();

  updateThinkingIndicator();
  highlightActiveMoveInList(index);
  updateNavButtons();
}

function renderBestMoveArrow(lan) {
  if (!lan || lan.length < 4) return;
  const from = lan.slice(0, 2);
  const to   = lan.slice(2, 4);
  state.board.addArrow(ARROW_TYPE.info, from, to);
}

// ─── Move List ────────────────────────────────────────────────────────────────

function createMoveCell(position, index) {
  const td = document.createElement('td');
  td.dataset.index = String(index);

  const moveCell = document.createElement('span');
  moveCell.className = 'move-cell';

  const badge = document.createElement('span');
  badge.className = `badge ${position.classification || ''}`;
  badge.title = classLabel(position.classification);

  const sanText = document.createElement('span');
  sanText.className = 'san-text';
  sanText.textContent = position.san;

  moveCell.append(badge, sanText);
  td.appendChild(moveCell);

  return td;
}

function createEmptyMoveCell() {
  const td = document.createElement('td');
  td.dataset.index = '';
  return td;
}

function buildMoveList() {
  const tbody = document.getElementById('move-list-body');
  const moveList = document.getElementById('move-list');
  const emptyState = document.getElementById('move-list-empty');
  tbody.innerHTML = '';

  if (state.positions.length <= 1) {
    // Only the starting position (FEN input) — no moves to show
    moveList.classList.remove('visible');
    emptyState.style.display = 'block';
    emptyState.textContent = 'FEN loaded — single position';
    return;
  }

  moveList.classList.add('visible');
  emptyState.style.display = 'none';

  // Build rows: one per move pair (white + black)
  for (let i = 1; i < state.positions.length; i += 2) {
    const whitePos = state.positions[i];
    const blackPos = state.positions[i + 1]; // may be undefined

    const moveNum = Math.ceil(i / 2);
    const tr = document.createElement('tr');
    const moveNumCell = document.createElement('td');
    moveNumCell.className = 'move-num';
    moveNumCell.textContent = `${moveNum}.`;

    tr.append(
      moveNumCell,
      createMoveCell(whitePos, i),
      blackPos ? createMoveCell(blackPos, i + 1) : createEmptyMoveCell(),
    );
    tbody.appendChild(tr);
  }
}

function onMoveListClick(e) {
  const cell = e.target.closest('[data-index]');
  if (!cell || !cell.dataset.index) return;
  navigateTo(parseInt(cell.dataset.index, 10));
}

function classLabel(classification) {
  const labels = {
    brilliant: 'Brilliant !!',
    excellent: 'Excellent !',
    good: 'Good',
    inaccuracy: 'Inaccuracy ?!',
    mistake: 'Mistake ?',
    blunder: 'Blunder ??',
  };
  return labels[classification] || '';
}

function updateMoveListBadge(index) {
  if (index <= 0) return;
  const cell = document.querySelector(`[data-index="${index}"]`);
  if (!cell) return;
  const badge = cell.querySelector('.badge');
  if (!badge) return;
  const cls = state.positions[index].classification || '';
  badge.className = `badge ${cls}`;
  badge.title = classLabel(cls);
}

function highlightActiveMoveInList(index) {
  document.querySelectorAll('#move-list-body [data-index]').forEach(td => {
    td.classList.remove('active-move');
  });
  if (index > 0) {
    const cell = document.querySelector(`[data-index="${index}"]`);
    if (cell) {
      cell.classList.add('active-move');
      cell.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }
}

// ─── UI Helpers ───────────────────────────────────────────────────────────────

function setEngineStatus(status) {
  const el = document.getElementById('engine-status');
  if (status === 'ready') {
    el.hidden = true;
  } else {
    el.textContent = status;
    el.classList.remove('ready');
  }
}

function updateThinkingIndicator() {
  const ind = document.getElementById('thinking-indicator');
  const showThinking = state.engineBusy && state.positions[state.currentIndex]?.cp === null;
  ind.hidden = !showThinking;
}

function updateNavButtons() {
  document.getElementById('btn-start').disabled = state.currentIndex === 0;
  document.getElementById('btn-prev').disabled  = state.currentIndex === 0;
  document.getElementById('btn-next').disabled  = state.currentIndex >= state.positions.length - 1;
  document.getElementById('btn-end').disabled   = state.currentIndex >= state.positions.length - 1;
}

function showError(msg) {
  const el = document.getElementById('error-msg');
  el.textContent = msg;
  el.hidden = false;
}

function hideError() {
  document.getElementById('error-msg').hidden = true;
}

// ─── Game Loading ─────────────────────────────────────────────────────────────

function onGameLoaded() {
  hideError();
  buildMoveList();
  navigateTo(0);

  // Queue all positions for background analysis
  enqueueAll();
  processQueue();
}

// ─── Controls Wiring ─────────────────────────────────────────────────────────

function wireControls() {
  document.getElementById('move-list-body').addEventListener('click', onMoveListClick);

  document.getElementById('btn-start').onclick = () => navigateTo(0);
  document.getElementById('btn-prev').onclick  = () => navigateTo(state.currentIndex - 1);
  document.getElementById('btn-next').onclick  = () => navigateTo(state.currentIndex + 1);
  document.getElementById('btn-end').onclick   = () => navigateTo(state.positions.length - 1);

  document.getElementById('btn-load').onclick = () => {
    const text = document.getElementById('pgn-input').value.trim();
    if (!text) return showError('Please paste a PGN or FEN first.');
    try {
      state.positions = isFen(text) ? loadFen(text) : loadPgn(text);
      onGameLoaded();
    } catch (e) {
      showError(e.message);
    }
  };

  document.getElementById('btn-flip').onclick = () => {
    state.orientation = state.orientation === COLOR.white ? COLOR.black : COLOR.white;
    state.board.setOrientation(state.orientation, true);
  };

  const themeBtn = document.getElementById('btn-theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)');
  // Initialise icon to reflect current effective theme
  const effectiveDark = document.documentElement.dataset.theme === 'dark'
    || (!document.documentElement.dataset.theme && prefersDark.matches);
  themeBtn.textContent = effectiveDark ? '☀' : '☾';

  themeBtn.onclick = () => {
    const isDark = document.documentElement.dataset.theme === 'dark'
      || (!document.documentElement.dataset.theme && prefersDark.matches);
    document.documentElement.dataset.theme = isDark ? 'light' : 'dark';
    themeBtn.textContent = isDark ? '☾' : '☀';
  };

  document.getElementById('btn-best-move').onclick = () => {
    state.showBestMove = !state.showBestMove;
    const btn = document.getElementById('btn-best-move');
    btn.textContent = `Best Move: ${state.showBestMove ? 'On' : 'Off'}`;
    btn.classList.toggle('active', state.showBestMove);
    // Immediately show or hide the arrow for the current position
    state.board.removeArrows();
    if (state.showBestMove) {
      const pos = state.positions[state.currentIndex];
      if (pos?.bestMove) renderBestMoveArrow(pos.bestMove);
    }
  };

  document.addEventListener('keydown', (e) => {
    // Don't hijack arrow keys when textarea is focused
    if (document.activeElement === document.getElementById('pgn-input')) return;
    if (e.key === 'ArrowLeft')  { e.preventDefault(); navigateTo(state.currentIndex - 1); }
    if (e.key === 'ArrowRight') { e.preventDefault(); navigateTo(state.currentIndex + 1); }
    if (e.key === 'ArrowUp')    { e.preventDefault(); navigateTo(0); }
    if (e.key === 'ArrowDown')  { e.preventDefault(); navigateTo(state.positions.length - 1); }
  });

  // Ctrl+Enter or Cmd+Enter in textarea → load
  document.getElementById('pgn-input').addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      document.getElementById('btn-load').click();
    }
  });
}

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init() {
  initBoard();
  initEngine();
  wireControls();
  updateNavButtons();
  // Static initial state — no loading pulse until a game is actually loaded
  document.getElementById('eval-bar-white').style.height = '50%';
  document.getElementById('eval-bar-black').style.height = '50%';
}

init();
