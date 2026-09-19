    // Where the API lives, relative to whoever served this page. The standalone server serves it at
    // the root (any host/port - COMFYCRAWLER_PORT can move it off 5555); inside ComfyUI it's served
    // at /comfycrawler/, because ComfyUI keeps its own /api/... at the root (comfy_node.py).
    const SERVER_URL = window.location.pathname.startsWith('/comfycrawler') ? '/comfycrawler' : '';

    // Set only by tools/export_showcase.py, which splices a `window.COMFYCRAWLER_SHOWCASE = true;`
    // script tag into its copy of index.html ahead of game.js. Gates the no-backend showcase
    // export: no CREATE, no delete, saved-dungeon list from a static manifest instead of the
    // server, favorite/beaten kept in this browser's own localStorage instead of meta.json.
    const SHOWCASE_MODE = window.COMFYCRAWLER_SHOWCASE === true;

    // ---- Remembered choices -------------------------------------------------------------------
    // Options (difficulty, max frame rate, ending video and its look, screensaver wait) and the
    // quick-ideas shuffle count are saved by the server (server.py PAGE SETTINGS), not only in this
    // browser: a browser keeps localStorage per address, so the standalone page (127.0.0.1:5555) and
    // the one inside ComfyUI (:8188/comfycrawler/) would each remember their own - a run played on one
    // ignored Ending Video being switched on in the other. The server writes its copy into the page
    // (#savedSettings), so every read below stays synchronous; each change goes back to it, batched
    // and flushed as the page closes. localStorage stays as a mirror: it answers for a key the server
    // has nothing for, and that answer is uploaded once, so choices made before this carry over.
    const prefs = (() => {
      let saved = {};
      try {
        const tag = document.getElementById('savedSettings');
        const parsed = tag ? JSON.parse(tag.textContent || '{}') : {};
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) saved = parsed;
      } catch (_) { /* unreadable - this browser's own copy answers instead */ }
      const values = { ...saved };
      const unsent = {};
      let sendTimer = null;

      function send(asBeacon) {
        if (sendTimer) { clearTimeout(sendTimer); sendTimer = null; }
        const keys = Object.keys(unsent);
        if (!keys.length) return;
        // No server to mirror to in the showcase export - localStorage above is the whole store.
        if (SHOWCASE_MODE) { keys.forEach((k) => { delete unsent[k]; }); return; }
        const body = JSON.stringify(unsent);
        keys.forEach((k) => { delete unsent[k]; });
        const url = `${SERVER_URL}/api/settings`;
        if (asBeacon && navigator.sendBeacon
            && navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }))) return;
        fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true })
          .catch(() => { /* no server (a copy of the page served elsewhere) - localStorage has it */ });
      }
      function queue(key, value) {
        unsent[key] = value;
        if (!sendTimer) sendTimer = setTimeout(() => send(false), 400);   // a slider fires per step
      }
      window.addEventListener('pagehide', () => send(true));

      return {
        get(key) {
          if (Object.prototype.hasOwnProperty.call(values, key)) {
            try { if (localStorage.getItem(key) !== values[key]) localStorage.setItem(key, values[key]); }
            catch (_) { /* storage disabled - the server's copy is what counts anyway */ }
            return values[key];
          }
          let local = null;
          try { local = localStorage.getItem(key); } catch (_) { /* storage disabled */ }
          if (local !== null) { values[key] = local; queue(key, local); }
          return local;
        },
        set(key, value) {
          const text = String(value);
          values[key] = text;
          try { localStorage.setItem(key, text); } catch (_) { /* storage disabled or full */ }
          queue(key, text);
        },
      };
    })();

    const appContainer = document.getElementById('appContainer');
    const screenSetup = document.getElementById('screenSetup');
    const screenProgress = document.getElementById('screenProgress');
    const screenGame = document.getElementById('screenGame');
    const screenShowcase = document.getElementById('screenShowcase');
    const modalSettings = document.getElementById('modalSettings');
    const victoryModal = document.getElementById('victoryModal');
    const btnPlayAgain = document.getElementById('btnPlayAgain');
    const btnVictoryFavorite = document.getElementById('btnVictoryFavorite');
    const winMovesCount = document.getElementById('winMovesCount');
    const victoryText = document.getElementById('victoryText');
    const confettiCanvas = document.getElementById('confettiCanvas');
    const defeatModal = document.getElementById('defeatModal');
    const defeatText = document.getElementById('defeatText');
    const deadMovesCount = document.getElementById('deadMovesCount');
    const btnRestartDungeon = document.getElementById('btnRestartDungeon');
    const btnDeadMainMenu = document.getElementById('btnDeadMainMenu');

    // Engine mode is fixed at v6 (see activeMode below) - the picker was removed. The krea2
    // resolution / steps / portrait-res number inputs were removed too (never adjusted); the
    // server uses its own defaults. The only setup dropdowns left are graphics quality and
    // sound generation.
    const gfxQualitySelect = document.getElementById('gfxQualitySelect');
    const soundModeSelect = document.getElementById('soundModeSelect');
    const difficultyRow = document.getElementById('difficultyRow');
    const gridDesc = document.getElementById('gridDesc');
    // Options' Off / On pair for Last Attack Frame - see setLastAttackFrame.
    const lastAttackFrameRow = document.getElementById('lastAttackFrameRow');

    // Maze size is a three-way difficulty pick, not a free slider - one knob with three
    // meanings instead of a number nobody knows how to read. 111 is the new ceiling
    // (generateAuthentic3DMaze used to clamp at 100).
    // `grids` is now the CARVED corridor count, not the finished tile count - the loop passes in
    // braidMaze() turn walls into floor on top of it, and so does the stairs' hallway (see
    // MAZE.exitHallCells). Measured over 1500 mazes each, the three settings below finish at
    // about 40 / 77 / 124 walkable tiles, of which ~5 are hallway. The HUD's "x/y Tiles" badge
    // reads passagesList, so it always shows the real number.
    // `enemyHpMul` scales every foe's maxHp in initEnemy (walker, flyer, boss and both pack
    // types alike), so the harder mazes also hit back harder. Easy leaves the tuned base
    // numbers alone; Medium is +25%, Hard is +60%.
    const DIFFICULTIES = {
      easy:   { grids: 33,  enemyHpMul: 1,    desc: 'Easy: a small looping labyrinth - 33 carved corridors plus shortcuts, with a nearby Exit.' },
      medium: { grids: 66,  enemyHpMul: 1.25, desc: 'Medium: 66 carved corridors plus shortcuts - branching routes, lanterns, a distant Exit, and foes with 25% more health.' },
      hard:   { grids: 111, enemyHpMul: 1.6,  desc: 'Hard: 111 carved corridors plus shortcuts - a sprawling, looping maze with a long, well-gated route to the Exit, and foes with 60% more health.' }
    };
    const MAX_GRIDS = 111;

    // How the maze is SHAPED, as opposed to how big it is. The generator used to emit a PERFECT
    // maze - a spanning tree, exactly one route between any two tiles - which plays as a single
    // hallway you follow, flipping whatever switch you happen to walk past, until it ends. These
    // three knobs make it MULTICURSAL: real loops, real junctions, real route choices.
    const MAZE = {
      // Fraction of carve steps that grow from a RANDOM frontier cell instead of the newest
      // one. 0 is a pure recursive backtracker: it commits to one direction until it runs out
      // of room, which makes long snaking corridors. Raising it grows several corridors at once
      // - bushier, more forks, but much shorter passages.
      //
      // It defaults to 0 because it turned out to be a bad way to buy junctions. Measured over
      // 250 hard mazes, raising it to 0.28 took the start->exit walk from 92 steps to 42 (a
      // shallower carve tree puts the furthest cell much nearer the spawn) and bought only ~5
      // extra junctions - while the braid knobs below buy ~19 junctions for ~29 steps. Left in
      // as a knob because it is the only lever on corridor LENGTH, but turn it up knowing it
      // shortens the whole dungeon.
      branchChance: 0,
      // Fraction of dead ends given a second opening. This is the classic braid, and it is what
      // actually creates loops: the corridor that led to the tip becomes a circuit. Deliberately
      // below 1 - placeGatesAndSwitches scores dead ends highest when hiding a lever, so braiding
      // them all away leaves it nowhere out-of-the-way to mount one.
      braidDeadEnds: 0.70,
      // Extra wall knock-outs between two already-connected cells, as a fraction of cell count.
      // Dead-end braiding only ties off the tips; these cut across the middle of long corridors,
      // which is what gives a route a choice partway along it instead of only at its end.
      extraLoops: 0.18,
      // Cells of private hallway carved out past the maze to hold the stairs - see
      // relocateExit. This is NOT part of the size budget: `grids` counts carved corridors and
      // these cells are ones the carve stopped short of, so a difficulty still buys the same
      // maze and the approach is added on top of it. Each cell is two tiles, so 3 puts the
      // stairs at the end of a six-tile run with the boss standing in it.
      exitHallCells: 3
    };
    let selectedDifficulty = 'medium';
    // LAST ATTACK FRAME - 'off' | 'on' | 'quick' | 'flip' | 'mixed'. Off, a foe's attack frame goes
    // up with its telegraph, well before the blow lands. The ways to close that gap being tried:
    //   on    - CREATE asks the server for one more frame per foe, its strike, which
    //           drawEnemyBody swaps in on the tick the blow lands; the run is saved as frame
    //           version 2. The mode gates the swap too, so leaving 'on' puts every dungeon,
    //           version 2 ones included, back on the attack frame.
    //   quick - no extra frame and nothing generated differently. The wind-up is dropped
    //           instead: the attack frame waits for the blow and arrives with it. See the
    //           grounded AI's telegraph and drawEnemyBody.
    //   flip  - no extra frame, and the wind-up plays exactly as Off. On the tick the blow
    //           lands the foe is drawn mirrored for the rest of that attack, so the hit reads
    //           as a snap of movement. Purely a draw-time mirror - see drawEnemyBody.
    //   mixed - quick for every foe on the ground (walker, runts, boss), flip for every foe in
    //           the air (flyer, fledglings). Nothing reads this directly: each foe's own mode
    //           comes from attackFrameModeFor.
    let lastAttackFrameMode = 'off';
    const wallPromptInput = document.getElementById('wallPromptInput');
    const playerPromptInput = document.getElementById('playerPromptInput');
    const playerFileInput = document.getElementById('playerFileInput');
    const btnAttachPlayerImage = document.getElementById('btnAttachPlayerImage');
    const playerImageBadge = document.getElementById('playerImageBadge');
    const playerImageThumb = document.getElementById('playerImageThumb');
    const playerImageName = document.getElementById('playerImageName');
    const btnClearPlayerImage = document.getElementById('btnClearPlayerImage');
    let uploadedPlayerImageDataUrl = null;

    const weaponPromptInput = document.getElementById('weaponPromptInput');
    const enemyPromptInput = document.getElementById('enemyPromptInput');
    // Attached reference images, keyed the same way the request payload expects them.
    const attachedImages = { player: null, weapon: null, enemy: null };

    const btnCreate = document.getElementById('btnCreate');
    const btnSettings = document.getElementById('btnSettings');
    const btnCloseSettings = document.getElementById('btnCloseSettings');
    const btnSaveSettings = document.getElementById('btnSaveSettings');

    // The title bar's ? - credits, the links, and the parts list. Static text; the stylesheet
    // keeps the button itself to the main menu.
    const btnAbout = document.getElementById('btnAbout');
    const modalAbout = document.getElementById('modalAbout');
    const btnCloseAbout = document.getElementById('btnCloseAbout');
    const btnAboutOk = document.getElementById('btnAboutOk');

    // History window: the saved-dungeon list, plus the confirm box the trash can opens.
    const btnHistory = document.getElementById('btnHistory');
    const modalHistory = document.getElementById('modalHistory');
    const historyList = document.getElementById('historyList');
    const historyFootNote = document.getElementById('historyFootNote');
    const btnCloseHistory = document.getElementById('btnCloseHistory');
    const btnHistoryOk = document.getElementById('btnHistoryOk');
    const historySimilarOnly = document.getElementById('historySimilarOnly');
    const historySimilarOnlyLabel = document.getElementById('historySimilarOnlyLabel');
    const showcaseList = document.getElementById('showcaseList');
    const showcaseFootNote = document.getElementById('showcaseFootNote');
    // Rows or tiles - the pair in the History window's footer, and the pair in the showcase
    // gallery's header. Both drive the one setting; see setHistoryView.
    const btnHistoryViewList = document.getElementById('btnHistoryViewList');
    const btnHistoryViewTiles = document.getElementById('btnHistoryViewTiles');
    const btnShowcaseViewList = document.getElementById('btnShowcaseViewList');
    const btnShowcaseViewTiles = document.getElementById('btnShowcaseViewTiles');
    const btnOpenSessionsFolder = document.getElementById('btnOpenSessionsFolder');
    const btnOpenAssetsFolder = document.getElementById('btnOpenAssetsFolder');
    const modalHistoryConfirm = document.getElementById('modalHistoryConfirm');
    const historyConfirmName = document.getElementById('historyConfirmName');
    const btnHistoryConfirmClose = document.getElementById('btnHistoryConfirmClose');
    const btnHistoryConfirmCancel = document.getElementById('btnHistoryConfirmCancel');
    const btnHistoryConfirmDelete = document.getElementById('btnHistoryConfirmDelete');
    // ...and the one a row's Start or Prompts button opens when a run is live behind the window.
    const modalLeaveRunConfirm = document.getElementById('modalLeaveRunConfirm');
    const leaveRunConfirmIcon = document.getElementById('leaveRunConfirmIcon');
    const leaveRunConfirmName = document.getElementById('leaveRunConfirmName');
    const leaveRunConfirmText = document.getElementById('leaveRunConfirmText');
    const btnLeaveRunConfirmClose = document.getElementById('btnLeaveRunConfirmClose');
    const btnLeaveRunConfirmCancel = document.getElementById('btnLeaveRunConfirmCancel');
    const btnLeaveRunConfirmContinue = document.getElementById('btnLeaveRunConfirmContinue');

    const progBarChunks = document.getElementById('progBarChunks');
    const progStatusText = document.getElementById('progStatusText');
    const progPercentText = document.getElementById('progPercentText');
    const progTimer = document.getElementById('progTimer');
    const progPhaseText = document.getElementById('progPhaseText');
    const crawlStage = document.getElementById('crawlStage');
    const crawlText = document.getElementById('crawlText');
    const crawlPending = document.getElementById('crawlPending');
    const btnEnterDungeon = document.getElementById('btnEnterDungeon');
    const btnNarrateManual = document.getElementById('btnNarrateManual');
    const progHeaderText = document.getElementById('progHeaderText');
    const progHeaderIcon = document.getElementById('progHeaderIcon');

    // The browser tab is the second progress readout. Generating a dungeon takes minutes,
    // which is long enough that the tab is usually in the background, so the percent goes
    // into the title where it can be read from the tab strip without switching back - and
    // when the assets land it shouts instead of counting.
    const BASE_TAB_TITLE = 'ComfyCrawler by sorryaboutyourcats';
    function setTabTitlePercent(percent) {
      const pct = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
      document.title = pct + '% ' + BASE_TAB_TITLE;
    }
    function setTabTitleReady() {
      document.title = 'READY TO PLAY ComfyCrawler!';
    }
    function resetTabTitle() {
      document.title = BASE_TAB_TITLE;
    }

    const viewportCanvas = document.getElementById('viewportCanvas');
    const gameVideo = document.getElementById('gameVideo');
    const statusPos = document.getElementById('statusPos');
    const mapProgressBadge = document.getElementById('mapProgressBadge');

    const titleButtons = document.getElementById('titleButtons');
    const btnUp = document.getElementById('btnUp');
    const btnDown = document.getElementById('btnDown');
    const btnLeft = document.getElementById('btnLeft');
    const btnRight = document.getElementById('btnRight');
    const btnAction = document.getElementById('btnAction');
    const btnMaximize = document.getElementById('btnMaximize');
    const btnClose = document.getElementById('btnClose');

    // Quit-confirm box: what ESC / the title-bar ✕ opens during an active run instead of
    // an OS confirm() prompt. See openQuitConfirm/closeQuitConfirm further down.
    const modalQuitConfirm = document.getElementById('modalQuitConfirm');
    const btnQuitConfirmClose = document.getElementById('btnQuitConfirmClose');
    const btnQuitToMenu = document.getElementById('btnQuitToMenu');
    const btnQuitToHistory = document.getElementById('btnQuitToHistory');
    const btnQuitEraseRun = document.getElementById('btnQuitEraseRun');
    const modalEraseConfirm = document.getElementById('modalEraseConfirm');
    const eraseConfirmName = document.getElementById('eraseConfirmName');
    const btnEraseConfirmClose = document.getElementById('btnEraseConfirmClose');
    const btnEraseConfirmCancel = document.getElementById('btnEraseConfirmCancel');
    const btnEraseConfirmErase = document.getElementById('btnEraseConfirmErase');

    // The loading screen's own ✕ box - "stop generating" while the assets are being made,
    // "leave without entering" once ENTER is armed. See openLoadingExitConfirm further down.
    const modalLoadingExitConfirm = document.getElementById('modalLoadingExitConfirm');
    const loadingExitTitle = document.getElementById('loadingExitTitle');
    const loadingExitIcon = document.getElementById('loadingExitIcon');
    const loadingExitHead = document.getElementById('loadingExitHead');
    const loadingExitText = document.getElementById('loadingExitText');
    const btnLoadingExitClose = document.getElementById('btnLoadingExitClose');
    const btnLoadingExitStay = document.getElementById('btnLoadingExitStay');
    const btnLoadingExitGo = document.getElementById('btnLoadingExitGo');

    // ==========================================
    // RAYCASTER MAZE & TEXTURE ENGINE
    // ==========================================
    const screenWidth = 320;
    const screenHeight = 240;

    // Wall height in world units (one map cell is 1x1) and how far the camera sits BEHIND the
    // player's cell centre. Together these decide how much of the screen a faced wall covers:
    // coverage = WALL_HEIGHT / (0.5 + CAMERA_SETBACK), so ~0.62/0.92 = 67%, always leaving bands of
    // ceiling and floor with room for a duel.
    //
    // Both knobs are needed. Movement is strictly grid based, so a faced wall is otherwise ALWAYS
    // exactly 0.5 away and towers over the screen. Shortening walls alone does buy the headroom,
    // but at 0.36 (the value that works on its own) corridors turn into a squat crawlspace, because
    // it shrinks distant walls just as much as near ones. The setback only affects what is directly
    // ahead, so corridors keep their height.
    //
    // Both replace an earlier attempt that clamped the projected DISTANCE per column. That broke
    // perspective outright: near walls were drawn at a distance they weren't at, so their textures
    // compressed, and the near ends of side walls were cut short - which read as corridors opening
    // to the left and right that did not exist.
    const WALL_HEIGHT = 0.62;
    const CAMERA_SETBACK = 0.42;
    const TEX_SIZE = 256;

    // Texels per world unit on the floor and ceiling. This MUST stay exactly TEX_SIZE: the sampler
    // masks with & (TEX_SIZE - 1), so one full texture then lands on exactly one 1x1 map cell,
    // aligned to the cell boundaries. Any other value tiles at a rate that does not divide the
    // grid, and the texture's own seam lands somewhere in the middle of a cell instead of on its
    // edge - which is what put a second, off-centre copy of the floor and ceiling art inside every
    // square. (The previous TEX_SIZE / WALL_HEIGHT was a density tweak to counter the eye sitting
    // at WALL_HEIGHT/2 rather than 0.5; it fixed the grain and broke the alignment. Grain is a
    // texture-generation problem, not a UV one - fix it in the prompt, not here.)
    const SURFACE_TEXELS = TEX_SIZE;

    let ctx = viewportCanvas.getContext('2d');
    let imgData = ctx.createImageData(screenWidth, screenHeight);
    let buffer = imgData.data;
    // A 32-bit window onto the same pixels. The opaque passes (floor, ceiling, walls) write a
    // whole pixel with one store through this instead of four separate byte writes through
    // `buffer` - four stores plus four clamp-and-round conversions per pixel is a real slice of
    // the fill cost at 76,800 pixels a frame. The blend passes further down (exit stairwell,
    // open gates, and everything drawn with the 2D context) still go through `buffer`, since
    // they read the existing pixel back before mixing into it.
    //
    // Byte order inside that word is the machine's, not the canvas's, so work it out once
    // rather than assuming little-endian.
    let buf32 = new Uint32Array(buffer.buffer);
    const LITTLE_ENDIAN = (() => {
      const probe = new ArrayBuffer(4);
      new Uint32Array(probe)[0] = 0x01020304;
      return new Uint8Array(probe)[0] === 0x04;
    })();
    const PIX_R_SHIFT = LITTLE_ENDIAN ? 0 : 24;
    const PIX_G_SHIFT = LITTLE_ENDIAN ? 8 : 16;
    const PIX_B_SHIFT = LITTLE_ENDIAN ? 16 : 8;
    const PIX_ALPHA = LITTLE_ENDIAN ? 0xFF000000 : 0x000000FF;

    // ==========================================
    // FRAME RATE CAP
    // ==========================================
    // requestAnimationFrame offers a frame as often as the display will take one - 60 a second
    // on most screens, 144 or 240 on a fast one. Every one of those offers costs a full
    // software raycast, and on a high-refresh monitor that is the single biggest thing the page
    // does. This is the ceiling on how many of them we actually accept.
    //
    // It caps DRAWING only. Combat runs on its own fixed-timestep accumulator (see SIM_STEP),
    // so the fight ticks 60 times a second whatever this is set to - turning the cap down
    // makes the picture update less often, never the game run slower.
    //
    // Three loops draw the viewport - the main combatFrame, and the move/turn tweens in
    // animate3D and animateBump - but only ever one of them per frame, so they share this one
    // budget rather than each keeping their own (which would let a tween draw at 2x the cap).
    //
    // The cap is picked from a fixed list of NOTCHES rather than a free number: the rates
    // monitors and recordings actually run at, from a 12fps crawl for a very slow machine up to
    // 240. A free slider spent most of its travel on numbers nobody wants (143, 187) and made
    // the ones they do want hard to land on, so the slider walks these stops one at a time.
    // Anything else - an older saved value, a hand-edited one - is snapped to the nearest stop
    // by clampFpsCap, so there is only ever one set of rates in play.
    const FPS_STOPS = [12, 24, 30, 45, 60, 90, 120, 144, 200, 222, 240];
    const DEFAULT_FPS_CAP = 60;
    const FPS_CAP_KEY = 'comfycrawler.maxFps';
    let maxFps = DEFAULT_FPS_CAP;
    let minFrameMs = 1000 / DEFAULT_FPS_CAP;
    let nextViewportDraw = 0;

    // True at most once per minFrameMs, and consumes that slot when it says so.
    function viewportFrameAllowed(now) {
      // A millisecond of slack, because a 60Hz display hands out frames at 16.666ms and a 60fps
      // cap wants one every 16.667ms - without it every other frame would miss and the cap
      // would quietly halve itself to 30.
      if (now < nextViewportDraw - 1) return false;
      // Deadline-based rather than "last draw + interval", so the rate doesn't drift slower
      // than asked. Re-anchored to now whenever we have fallen a whole interval behind, so a
      // stall doesn't leave a backlog of deadlines to burn through at full speed.
      nextViewportDraw = (nextViewportDraw < now - minFrameMs)
        ? now + minFrameMs
        : nextViewportDraw + minFrameMs;
      return true;
    }

    // Snaps to the nearest notch rather than clamping to a range: the slider only ever hands
    // over a stop, but a saved value from before the stops existed (or an fps typed into
    // localStorage by hand) still has to land on one.
    function clampFpsCap(v) {
      const n = Number(v);
      if (!Number.isFinite(n)) return DEFAULT_FPS_CAP;
      let best = FPS_STOPS[0];
      for (const stop of FPS_STOPS) {
        if (Math.abs(stop - n) < Math.abs(best - n)) best = stop;
      }
      return best;
    }

    // Which notch an fps sits on - the slider's own value, since the track is indices.
    function fpsStopIndex(v) {
      return FPS_STOPS.indexOf(clampFpsCap(v));
    }

    function applyFpsCap(v) {
      maxFps = clampFpsCap(v);
      minFrameMs = 1000 / maxFps;
      // Raising the cap should take effect on the very next frame rather than after the old,
      // longer interval has run out.
      nextViewportDraw = 0;
    }

    let wallTexture = null;
    let ceilingTexture = null;
    let floorTexture = null;
    let wallLanternTexture = null;
    // The descending stairwell that marks the exit cell - see buildExitStairsTexture. Rebuilt
    // per dungeon so it is cut from that theme's own stone.
    let exitStairsTexture = null;
    // AI-generated wall fixture (torch/lantern/lamp) matted onto wallLanternTexture in
    // buildLanternWallFromBase. Null falls back to the procedural shapes drawn there.
    let aiLanternImg = null;

    // Door / switch textures - built the same way as wallLanternTexture (a full-cell wall
    // texture, selected in render3D's wall dispatch by MAP tile value: 3=closed door,
    // 4=switch OFF, 5=switch ON; 6=opened door, which is walkable and drawn as a sprite). The
    // aiDoorImg / aiSwitchImg are the style-matched cutouts the builders composite in; null
    // falls back to procedural shapes. There is only ONE switch cutout: the on texture is the
    // off texture's own fixture with its colours inverted. See buildDoorTexture /
    // buildSwitchWallTextures.
    let doorTexture = null;
    // The open gate (MAP tile 6) is a see-through billboard, not a wall texture - see
    // buildOpenDoorTexture and the open-gate pass at the end of render3D.
    let doorOpenTexture = null;
    const DOOR_SPR_W = 256, DOOR_SPR_H = 160;
    let switchWallOffTexture = null;
    let switchWallOnTexture = null;
    let aiDoorImg = null;
    let aiSwitchImg = null;

    let playerSpriteImg = null;
    let playerFaceImg = null;
    let playerSpriteFrames = [];
    // v5 (krea2) generates the weapon and shield as their own transparent sprites; the rig
    // draws these instead of the procedural bezier gear. Null in every other mode.
    let weaponSpriteImg = null;
    let shieldSpriteImg = null;
    let enemySpriteFrames = [];
    // The three foes generated from one typed enemy idea (server bundle.enemy_variants):
    // walker (ground), flyer (swoops from out of reach), boss (big, tanky). One is chosen
    // at random each time a battle starts. enemySpriteFrames tracks the active one.
    // {variant: {idle, attack, block}} of Images. Every foe has idle+attack; only the two
    // that fight on the ground have block. enemyFrames below points at the active foe's set.
    let enemyVariantImgs = {};
    let enemyFrames = null;
    let enemyStyleName = '';   // common foe name (walker/flyer)
    let enemyBossName = '';    // boss's own name (boss variant only)
    let bossDefeated = false;  // latched once the boss encounter is won - flips the screensaver's boss line
    // Each foe's own invented name (server bundle.enemy_names), when the three were designed
    // as separate species rather than derived from one another. Takes precedence over the
    // tag+common-name fallback below, because these really are three different creatures.
    let enemyVariantNames = {};
    // The generated intro: {location, hero, foe, boss, crawl:[...]}. Arrives from
    // /api/progress minutes before the art does, and names the enemies in combat.
    let dungeonStory = null;
    // Set once generation finishes; the player enters on their own schedule, not ours.
    let pendingBundle = null;
    // The History id of the dungeon currently being played, or null - set from either
    // bundle.history_id (a fresh CREATE) or entry.id (a History replay) the moment the run
    // starts, cleared back to null on openSetupScreen. Lets "Erase Current Run" in the quit
    // menu delete this exact saved session without the player having to find it in History.
    let currentRunHistoryId = null;
    // Whether currentRunHistoryId is already starred, mirrored here rather than read off
    // historyEntries because the victory box can show up before the History window has ever
    // been opened this session (historyEntries still []). Set alongside currentRunHistoryId
    // itself at both of its assignments below; the Victory box's star reads this, not the list.
    let currentRunFavorite = false;
    // The four prompts a History replay was made from, or null for a freshly generated run (its
    // own prompts are already sitting in the mad-lib fields - nothing to restore). Set only by
    // loadHistoryDungeon; openSetupScreen writes these back into the fields - as one undo step,
    // so whatever was typed there before is one Ctrl+Z away - then clears this back to null.
    let currentRunHistoryPrompts = null;
    let crawlStarted = false;
    // Date.now() timestamp until which the intro crawl counts as "being read", so the screen
    // saver's idle timer holds off even if the story shipped with no narration audio (or
    // autoplay blocked the clip) and there is nothing else - no audio, no video, no battle -
    // to already block it. Set from the crawl's own scroll duration in startCrawl(); belt and
    // braces alongside the narrationActive() check in screensaverBlocked().
    let crawlReadingUntil = 0;
    // True only while the server is actually rendering a dungeon for us. Drives the
    // "you will lose this" refresh warning and the cancel beacon further down - see the
    // beforeunload/pagehide pair next to the CREATE handler.
    let generationInFlight = false;
    // The two timers the loading screen runs: the tenth-of-a-second wall clock, and (on a fresh
    // dungeon rather than a History replay) the progress poll. Held out here instead of inside
    // the handlers that start them so the title bar's ✕ can stop a run from outside - see
    // leaveLoadingScreen().
    let genClockTimer = null;
    let genPollTimer = null;
    function stopGenerationTimers() {
      if (genClockTimer) { clearInterval(genClockTimer); genClockTimer = null; }
      if (genPollTimer) { clearInterval(genPollTimer); genPollTimer = null; }
    }
    // The one ending movie render happening outside a run, as /api/ending_video_job last
    // reported it: {state, session, percent, error, manual}. manual = a History row's movie button
    // asked for it, and while one of those is filming CREATE, Fill-in and the other rows' movie
    // buttons are greyed out - see watchEndingJob. Declared up here because the Fill-in label code
    // reads it while the page is still loading.
    let endingJob = { state: 'idle', session: null, percent: 0, error: null, manual: false };
    const ENDING_FILMING_LOCK_TITLE =
      'An ending movie is being filmed from History - this comes back as soon as it is done.';
    function endingManualFilming() {
      return !!endingJob.manual && (endingJob.state === 'queued' || endingJob.state === 'rendering');
    }

    // ---- Intro narration (Piper, pre-rendered server-side) -----------------
    // The server picks one narrator (alan or kristin) per story and ships back one WAV
    // clip per paragraph as a data URL in bundle.story.audio, in the same order as the
    // <p> elements startCrawl() builds - title first, then each crawl paragraph. Playback
    // is just one <audio> element working through that list; no voice picking, no
    // getVoices()/voiceschanged race, no Chrome pause-queue bug - all of that lived on the
    // browser-TTS side and none of it applies to a plain audio file.
    // Always on. There was a "Narrate the intro" checkbox (and a remembered
    // comfycrawler.narrate preference) here; the narration is the point of the loading screen
    // and now also cues the loading music, so it is no longer optional.

    // A beat of silence after the title and after each paragraph, so the crawl reads like
    // it's being spoken deliberately rather than one clip barging straight into the next.
    const NARRATE_PAUSE_MS = 700;

    let narrateAudio = null;       // one <audio> element, reused clip to clip
    let narrateClips = [];         // [{el: <p>, src: dataUrl}, ...] for the active story
    let narrateIndex = 0;
    let narrateStartCheck = null;
    let narratePauseTimer = null;

    function stopNarration() {
      restoreMenuMusic();       // no-op unless narration actually faded it out
      if (narratePauseTimer) { clearTimeout(narratePauseTimer); narratePauseTimer = null; }
      if (narrateStartCheck) { clearTimeout(narrateStartCheck); narrateStartCheck = null; }
      if (btnNarrateManual) btnNarrateManual.classList.add('hidden');
      if (narrateAudio) {
        try { narrateAudio.pause(); } catch (e) {}
        narrateAudio.removeAttribute('src');
      }
      if (crawlText) {
        crawlText.classList.remove('narrating');
        crawlText.querySelectorAll('p.speaking').forEach(p => p.classList.remove('speaking'));
      }
      narrateClips = [];
      narrateIndex = 0;
    }

    // True while there are clips queued for this story - narration is either speaking or
    // between paragraphs. The music hand-off waits on this: see armEnterDungeon.
    function narrationActive() {
      return narrateClips.length > 0;
    }

    // The narrator reaching the end of the crawl, as opposed to stopNarration()'s other
    // callers (a new dungeon, leaving for the game, unload), which are teardown and must not
    // start anything. This is the one that scores the rest of the loading screen.
    function finishNarration() {
      stopNarration();
      playScreenMusic('loading');
    }

    function playNarrationClip(i) {
      narrateIndex = i;
      narrateClips.forEach((c, idx) => c.el.classList.toggle('speaking', idx === i));
      if (i >= narrateClips.length) { finishNarration(); return; }
      narrateAudio.src = narrateClips[i].src;
      const p = narrateAudio.play();
      // A rejected promise (autoplay blocked) is handled by the startCheck timeout below,
      // not here - retrying belongs to a real click, not to code running the instant the
      // browser said no.
      if (p && p.catch) p.catch(() => {});
    }

    function advanceNarration() {
      if (narrateStartCheck) { clearTimeout(narrateStartCheck); narrateStartCheck = null; }
      if (btnNarrateManual) btnNarrateManual.classList.add('hidden');
      // Drop the highlight for the pause itself, so the dimming reads as part of the beat
      // rather than a jump-cut straight to the next line.
      narrateClips.forEach(c => c.el.classList.remove('speaking'));
      const next = narrateIndex + 1;
      if (next >= narrateClips.length) { finishNarration(); return; }
      narratePauseTimer = setTimeout(() => {
        narratePauseTimer = null;
        playNarrationClip(next);
      }, NARRATE_PAUSE_MS);
    }

    // Called on a real user click when autoplay blocked the first clip. narrateAudio.src
    // is still set to that same clip - nothing played yet - so this just retries it.
    function retryNarrationPlay() {
      if (!narrateAudio) return;
      if (btnNarrateManual) btnNarrateManual.classList.add('hidden');
      const p = narrateAudio.play();
      if (p && p.catch) p.catch(() => {
        if (btnNarrateManual) btnNarrateManual.classList.remove('hidden');
      });
    }

    function startNarration() {
      if (!crawlText) return;
      if (screenProgress.classList.contains('hidden')) return;
      const story = dungeonStory;
      if (!story || !Array.isArray(story.audio) || !story.audio.length) return;

      const paras = Array.from(crawlText.querySelectorAll('p'));
      const n = Math.min(paras.length, story.audio.length);
      if (!n) return;

      stopNarration();
      fadeOutMenuMusicForNarration();   // narration is about to actually speak - see stopNarration
                                        // above for the matching restore when it finishes
      crawlText.classList.add('narrating');
      for (let i = 0; i < n; i++) narrateClips.push({ el: paras[i], src: story.audio[i] });

      if (!narrateAudio) {
        narrateAudio = new Audio();
        narrateAudio.addEventListener('ended', advanceNarration);
        narrateAudio.addEventListener('error', advanceNarration);
      }
      playNarrationClip(0);

      // A blocked autoplay never fires 'play', 'ended' or 'error' - it just silently does
      // nothing. Without this check a blocked narrator looks identical to a broken one.
      narrateStartCheck = setTimeout(() => {
        if (narrateAudio.paused && btnNarrateManual) btnNarrateManual.classList.remove('hidden');
      }, 1500);
    }

    if (btnNarrateManual) {
      btnNarrateManual.addEventListener('click', () => {
        if (narrateClips.length) retryNarrationPlay();
        else startNarration();
      });
    }
    window.addEventListener('beforeunload', stopNarration);

    // ---- Sound effects (Stable Audio 3, generated per dungeon) -------------
    // The server ships bundle.sfx as {name: 'data:audio/wav;base64,...'} - eight one-shots
    // written from the same typed styles the art comes from, so the footstep matches the
    // floor and the swing matches the weapon.
    //
    // Web Audio rather than <audio> elements (which is what the narration above uses): a
    // one-shot has to overlap itself and be pitch-varied per hit, and an <audio> element
    // can do neither. The narration is a single long clip played once, so it keeps its
    // simpler path.
    //
    // Anything missing from the bundle - an older v3/v4/v5 dungeon, a clip that failed the
    // server's validator, a machine with no audio checkpoint - falls through to synthSfx(),
    // so the game is never silent and never throws over sound.
    // No mute UI - both always play. Web Audio still respects the OS/browser volume, and a
    // silent-by-preference player can just mute the tab.
    let audioCtx = null;
    let sfxMaster = null;
    let sfxBank = {};              // name -> AudioBuffer, for whatever the bundle supplied
    const sfxOn = true;

    let musicMaster = null;
    const musicOn = true;
    let musicBank = {};            // 'explore'/'battle' -> AudioBuffer
    let musicNodes = {};           // 'explore'/'battle' -> { src, gain }
    // A sub-bus carrying ONLY the dungeon's own explore/battle beds, so they can be ducked
    // under a screen loop and brought straight back. The menu and screen loops bypass it and
    // hang off musicMaster directly - ducking must not touch the thing being ducked FOR.
    // Without it the only way to quiet the dungeon was fadeOutDungeonMusic, which tears the
    // looping nodes down; getting them back would mean re-decoding the whole bank.
    let dungeonMusicBus = null;

    function sfxContext() {
      if (!audioCtx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        audioCtx = new AC();
        sfxMaster = audioCtx.createGain();
        sfxMaster.gain.value = 0.85;
        sfxMaster.connect(audioCtx.destination);
        musicMaster = audioCtx.createGain();
        musicMaster.gain.value = 0.6;
        musicMaster.connect(audioCtx.destination);
        dungeonMusicBus = audioCtx.createGain();
        dungeonMusicBus.gain.value = 1;
        dungeonMusicBus.connect(musicMaster);
      }
      // Created suspended under the autoplay policy until a real gesture resumes it. The
      // first-gesture listener below does that; resuming again here is harmless and covers
      // a context that got suspended later (backgrounded tab).
      if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
      return audioCtx;
    }

    function loadSfxBank(sfx) {
      // The UI sounds are static and shared across dungeons - carry them over rather than
      // re-fetching them on every entry.
      const kept = {};
      UI_SOUNDS.forEach(n => { if (sfxBank[n]) kept[n] = sfxBank[n]; });
      sfxBank = kept;
      if (!sfx) return;            // other modes / a failed pack: synthSfx covers everything
      const ctx = sfxContext();
      if (!ctx) return;
      Object.keys(sfx).forEach(name => {
        try {
          const b64 = sfx[name].split(',')[1];
          const bin = atob(b64);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          // Callback form, not the promise: Safari still ships the old signature.
          ctx.decodeAudioData(bytes.buffer, buf => { sfxBank[name] = buf; }, () => {});
        } catch (e) { /* one bad clip must not cost the other seven */ }
      });
    }

    // ---- Background music (Stable Audio 3, generated per dungeon, v6-only) -------------
    // The server ships bundle.music as {explore: 'data:audio/wav;base64,...', battle: ...} -
    // two ~30s tracks pre-crossfaded at their own loop seam server-side. Unlike sfx one-shots,
    // each track is a single long-lived looping AudioBufferSourceNode; toggleBattleMode
    // crossfades between them via setMusicMode rather than starting/stopping nodes.

    function stopMusic() {
      Object.values(musicNodes).forEach(node => {
        try { node.src.stop(); } catch (e) { /* already stopped */ }
        try { node.src.disconnect(); node.gain.disconnect(); } catch (e) { /* already gone */ }
      });
      musicNodes = {};
      musicBank = {};
    }

    function loadMusicBank(music) {
      stopMusic();                 // always tear down the previous dungeon's loops first
      if (!music) return;          // sound_mode wasn't "music_and_sound", or generation failed
      const ctx = sfxContext();
      if (!ctx) return;
      ['explore', 'battle'].forEach(name => {
        if (!music[name]) return;
        try {
          const b64 = music[name].split(',')[1];
          const bin = atob(b64);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          ctx.decodeAudioData(bytes.buffer, buf => {
            musicBank[name] = buf;
            const src = ctx.createBufferSource();
            src.buffer = buf;
            src.loop = true;
            const g = ctx.createGain();
            // Read combat state at the moment playback actually starts, not a hardcoded
            // default - a battle toggle could in principle land between request and decode.
            g.gain.value = ((name === 'battle') === combatState.inBattle) ? 1 : 0;
            src.connect(g); g.connect(dungeonMusicBus || musicMaster);
            src.start();
            musicNodes[name] = { src, gain: g };
          }, () => {});
        } catch (e) { /* one missing track must not cost the other */ }
      });
    }

    // The run is over (death, victory) and the loading loop is about to take the screen.
    // stopMusic() alone is a hard cut in the middle of a bar; this rides the beds down first
    // and tears them down after. The caller is responsible for the delay - both call sites
    // already wait before revealing their box.
    function fadeOutDungeonMusic(sec) {
      const ctx = sfxContext();
      if (!ctx) { stopMusic(); return; }
      const now = ctx.currentTime;
      Object.values(musicNodes).forEach(node => {
        node.gain.gain.cancelScheduledValues(now);
        node.gain.gain.setValueAtTime(node.gain.gain.value, now);
        node.gain.gain.linearRampToValueAtTime(0, now + sec);
      });
      setTimeout(stopMusic, sec * 1000 + 100);
    }

    // Pull the dungeon's bed down (or back up) without stopping it, so a screen loop can take
    // the foreground for a moment and hand it straight back. `level` is a multiplier on the
    // whole dungeon bus: 0 silences the beds, 1 restores them, and the explore/battle balance
    // underneath is untouched throughout.
    function duckDungeonMusic(level, sec) {
      const ctx = sfxContext();
      if (!ctx || !dungeonMusicBus) return;
      const now = ctx.currentTime;
      const g = dungeonMusicBus.gain;
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(level, now + Math.max(0.01, sec));
    }

    // Single call site drives both directions of the explore/battle crossfade.
    function setMusicMode(inBattle) {
      const ctx = sfxContext();
      if (!ctx) return;
      const now = ctx.currentTime;
      const dur = 1.5;
      ['explore', 'battle'].forEach(name => {
        const node = musicNodes[name];
        if (!node) return;
        const target = ((name === 'battle') === inBattle) ? 1 : 0;
        node.gain.gain.cancelScheduledValues(now);
        node.gain.gain.setValueAtTime(node.gain.gain.value, now);   // anchor before ramping
        node.gain.gain.linearRampToValueAtTime(target, now + dur);
      });
    }

    // A boss fight scores to the same battle bed as every other duel, so it is pitched down and
    // slowed to set it apart. playbackRate on the looping source shifts pitch and tempo together
    // (there is no time-stretch in the Web Audio graph); 1.0 is the track exactly as generated.
    // The rate is ramped, not snapped, so the bed sags into the boss fight and lifts back out.
    const BOSS_MUSIC_RATE = 0.82;
    function setBattleMusicRate(rate, sec) {
      const ctx = sfxContext();
      const node = musicNodes.battle;
      if (!ctx || !node) return;
      const now = ctx.currentTime;
      const p = node.src.playbackRate;
      p.cancelScheduledValues(now);
      p.setValueAtTime(p.value, now);
      p.linearRampToValueAtTime(rate, now + Math.max(0.01, sec || 1.5));
    }

    // ---- Main menu music (static, generated once, NOT per-dungeon) -------------
    // sounds/menu_music.wav is a fixed short loop, unlike explore/battle which are themed
    // per playthrough - see generate_menu_music_asset in server.py. Plays from the moment
    // the title screen is usable through the whole loading screen, fading out under the intro
    // narration and stopping for good once assets are ready and the "ready" chime plays.
    const MENU_MUSIC_VOLUME = 0.4125;     // was 0.75, then lowered 45% - much quieter than dungeon music
    let menuMusicBuf = null;
    let menuMusicLoading = false;
    let menuMusicNode = null;      // { src, gain } while actually playing
    let menuMusicStopped = false;  // true once the ready chime has silenced it for this run
    let menuMusicFaded = false;    // true while narration has faded it out (node kept alive for restore)

    function _spawnMenuMusicNode(initialGain) {
      const ctx = sfxContext();
      if (!ctx || !menuMusicBuf) return null;
      const src = ctx.createBufferSource();
      src.buffer = menuMusicBuf;
      src.loop = true;
      const g = ctx.createGain();
      g.gain.value = initialGain;
      src.connect(g); g.connect(musicMaster);
      src.start();
      return { src, gain: g };
    }

    function loadMenuMusic() {
      if (menuMusicBuf || menuMusicLoading) return;
      const ctx = sfxContext();
      if (!ctx) return;
      menuMusicLoading = true;
      fetch(`${SERVER_URL}/sounds/menu_music.wav`)
        .then(r => (r.ok ? r.arrayBuffer() : Promise.reject()))
        .then(ab => ctx.decodeAudioData(ab, buf => {
          menuMusicBuf = buf;
          menuMusicLoading = false;
          if (!menuMusicNode && !menuMusicStopped) menuMusicNode = _spawnMenuMusicNode(MENU_MUSIC_VOLUME);
        }, () => { menuMusicLoading = false; }))
        .catch(() => { menuMusicLoading = false; /* menu just plays without music */ });
    }

    function stopMenuMusicLoop() {
      if (!menuMusicNode) return;
      const node = menuMusicNode;
      menuMusicNode = null;
      try { node.src.stop(); } catch (e) {}
      try { node.src.disconnect(); node.gain.disconnect(); } catch (e) {}
    }

    // Retires the menu loop for the rest of the run. Called from playScreenMusic() - whichever
    // screen track comes up first (normally the loading loop, the moment the narrator stops)
    // is what the menu loop hands off to, and it never comes back until returnToMenuMusic().
    function stopMenuMusicForLoadingComplete() {
      menuMusicStopped = true;
      menuMusicFaded = false;
      if (!menuMusicNode) return;
      const ctx = sfxContext();
      const now = ctx ? ctx.currentTime : 0;
      const node = menuMusicNode;
      node.gain.gain.cancelScheduledValues(now);
      node.gain.gain.setValueAtTime(node.gain.gain.value, now);
      node.gain.gain.linearRampToValueAtTime(0, now + 0.6);
      menuMusicNode = null;
      setTimeout(() => {
        try { node.src.stop(); node.src.disconnect(); node.gain.disconnect(); } catch (e) {}
      }, 700);
    }

    // Fades the menu music all the way out for the intro narration - the loop keeps running
    // silently so restoreMenuMusic() can bring it back if the narration is skipped. A no-op if
    // narration is off (never called), if the menu music failed to load, or if the
    // loading-complete chime already stopped it for good.
    function fadeOutMenuMusicForNarration() {
      if (!menuMusicNode || menuMusicStopped || menuMusicFaded) return;
      menuMusicFaded = true;
      const ctx = sfxContext();
      const now = ctx.currentTime;
      menuMusicNode.gain.gain.cancelScheduledValues(now);
      menuMusicNode.gain.gain.setValueAtTime(menuMusicNode.gain.gain.value, now);
      menuMusicNode.gain.gain.linearRampToValueAtTime(0, now + 1.5);
    }

    function restoreMenuMusic() {
      if (!menuMusicNode || menuMusicStopped || !menuMusicFaded) return;
      menuMusicFaded = false;
      const ctx = sfxContext();
      const now = ctx.currentTime;
      menuMusicNode.gain.gain.cancelScheduledValues(now);
      menuMusicNode.gain.gain.setValueAtTime(menuMusicNode.gain.gain.value, now);
      menuMusicNode.gain.gain.linearRampToValueAtTime(MENU_MUSIC_VOLUME, now + 0.6);
    }

    // Win, lose, or quit back to the title screen: the dungeon's own music must stop, and the
    // menu loop restarts from silence and eases back up rather than snapping to full volume.
    // The win or death loop has been running underneath its box, so it fades down across the
    // same beat the menu loop is fading up - a crossfade, not a hard cut.
    function returnToMenuMusic() {
      stopMusic();
      stopScreenMusic(2.0);
      stopMenuMusicLoop();
      menuMusicStopped = false;
      menuMusicFaded = false;
      if (!menuMusicBuf) { loadMenuMusic(); return; }
      menuMusicNode = _spawnMenuMusicNode(0);
      if (!menuMusicNode) return;
      const ctx = sfxContext();
      menuMusicNode.gain.gain.linearRampToValueAtTime(MENU_MUSIC_VOLUME, ctx.currentTime + 3.0);
    }

    // ---- Screen music (static, generated once, NOT per-dungeon) -------------
    // More fixed loops alongside the menu one, served from sounds/<name>_music.wav - see
    // STATIC_MUSIC in server.py:
    //   loading  picks up exactly where the intro narration puts it down and carries the
    //            loading screen to the ENTER button
    //   death    under the death box
    //   victory  under the victory box - a pool of five of these, one picked per dungeon
    //            style; see VICTORY_MUSIC_TRACKS below
    //   levelup  under the level-up choice box. The odd one out: it plays DURING a run rather
    //            than over a box that ends one, so instead of the dungeon's bed being faded
    //            out under it, the bed is ducked on dungeonMusicBus and handed straight back.
    // Exactly one of these and the menu loop is ever audible: playScreenMusic() retires the
    // menu loop for the run and cross-fades off whichever screen track was already up, and
    // returnToMenuMusic() fades the lot out as the menu comes back.
    const SCREEN_MUSIC_VOLUME = 0.4125;   // same bed level as the menu loop
    const SCREEN_MUSIC_FADE_IN = 1.5;
    const SCREEN_MUSIC_FADE_OUT = 0.6;
    let screenMusicBufs = {};      // name -> AudioBuffer, once fetched and decoded
    let screenMusicLoading = {};   // name -> true while its fetch is in flight
    let screenMusicNode = null;    // { name, src, gain } while actually playing
    // The track playScreenMusic() was asked for. Held separately from screenMusicNode so a
    // request made before the buffer arrives can still start on decode - and so that a
    // stopScreenMusic() in between cancels it, which is what keeps a track requested at the
    // death box from starting after the player has already restarted out of it.
    let screenMusicWanted = null;
    // A start that has been scheduled a beat out (the victory / death stings play first). Held
    // so stopScreenMusic() can cancel it if the player leaves the box before it fires -
    // otherwise the loop begins playing on top of the menu music it should never have reached.
    let screenMusicDelayTimer = null;

    // playScreenMusic(name) after `ms`, unless stopScreenMusic() cancels it first.
    function deferScreenMusic(name, ms) {
      if (screenMusicDelayTimer) clearTimeout(screenMusicDelayTimer);
      screenMusicDelayTimer = setTimeout(() => {
        screenMusicDelayTimer = null;
        playScreenMusic(name);
      }, ms);
    }

    function loadScreenMusic(name) {
      if (screenMusicBufs[name] || screenMusicLoading[name]) return;
      const ctx = sfxContext();
      if (!ctx) return;
      screenMusicLoading[name] = true;
      fetch(`${SERVER_URL}/sounds/${name}_music.wav`)
        .then(r => (r.ok ? r.arrayBuffer() : Promise.reject()))
        .then(ab => ctx.decodeAudioData(ab, buf => {
          screenMusicBufs[name] = buf;
          screenMusicLoading[name] = false;
          // Whatever was wanted may have changed (or been cancelled) while this downloaded.
          if (screenMusicWanted === name && !screenMusicNode) playScreenMusic(name);
        }, () => { screenMusicLoading[name] = false; }))
        .catch(() => { screenMusicLoading[name] = false; /* that screen runs silent */ });
    }

    // Idempotent per track: every trigger (narration ending, the victory box, the death box)
    // can call this without checking what is already playing.
    function playScreenMusic(name) {
      screenMusicWanted = name;
      stopMenuMusicForLoadingComplete();   // the menu loop's job is over for this run
      if (screenMusicNode && screenMusicNode.name === name) return;
      _fadeOutScreenMusicNode(SCREEN_MUSIC_FADE_OUT);   // swapping tracks, not stopping
      if (!screenMusicBufs[name]) { loadScreenMusic(name); return; }
      const ctx = sfxContext();
      if (!ctx) return;
      const src = ctx.createBufferSource();
      src.buffer = screenMusicBufs[name];
      src.loop = true;
      const g = ctx.createGain();
      g.gain.value = 0;
      src.connect(g); g.connect(musicMaster);
      src.start();
      g.gain.linearRampToValueAtTime(SCREEN_MUSIC_VOLUME, ctx.currentTime + SCREEN_MUSIC_FADE_IN);
      screenMusicNode = { name, src, gain: g };
    }

    // Rides the current node down and tears it down after, without touching screenMusicWanted
    // - playScreenMusic uses it to cross-fade, stopScreenMusic to actually stop.
    function _fadeOutScreenMusicNode(fadeSec) {
      if (!screenMusicNode) return;
      const node = screenMusicNode;
      screenMusicNode = null;
      const ctx = sfxContext();
      if (!ctx || fadeSec <= 0) {
        try { node.src.stop(); node.src.disconnect(); node.gain.disconnect(); } catch (e) {}
        return;
      }
      const now = ctx.currentTime;
      node.gain.gain.cancelScheduledValues(now);
      node.gain.gain.setValueAtTime(node.gain.gain.value, now);
      node.gain.gain.linearRampToValueAtTime(0, now + fadeSec);
      setTimeout(() => {
        try { node.src.stop(); node.src.disconnect(); node.gain.disconnect(); } catch (e) {}
      }, fadeSec * 1000 + 100);
    }

    function stopScreenMusic(fadeSec) {
      if (screenMusicDelayTimer) { clearTimeout(screenMusicDelayTimer); screenMusicDelayTimer = null; }
      screenMusicWanted = null;
      _fadeOutScreenMusicNode(fadeSec === undefined ? SCREEN_MUSIC_FADE_OUT : fadeSec);
    }

    // Pull whichever screen loop is up down to `level` of its bed volume (1 puts it back)
    // without stopping it, so the outro narration can speak over the victory box and hand the
    // music straight back. The dungeon's own beds have duckDungeonMusic; the screen loops
    // bypass that bus, so they need their own.
    // Reads the live gain rather than assuming SCREEN_MUSIC_VOLUME: a duck applied while
    // playScreenMusic's fade-in is still ramping cancels that ramp, and picking up from
    // wherever it had got to is what keeps the two from stepping on each other.
    function duckScreenMusic(level, sec) {
      const ctx = sfxContext();
      if (!ctx || !screenMusicNode) return;
      const g = screenMusicNode.gain.gain;
      const now = ctx.currentTime;
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(SCREEN_MUSIC_VOLUME * level, now + Math.max(0.01, sec));
    }

    // ---- The victory pool --------------------------------------------------
    // Winning does not always sound the same. Five victory loops ship (see the victory block of
    // STATIC_MUSIC in server.py, which this list mirrors IN ORDER - the index below is an index
    // into both), and which one scores the victory box is decided by the dungeon's own typed
    // style rather than by chance:
    //
    //     "haunted mansion" -> hash -> 0 -> victory          every haunted mansion run, forever
    //     "forest"          -> hash -> 3 -> victory_synth_2  every forest run, forever
    //
    // So it feels random when you look across styles, and is completely fixed within one: a
    // brand new forest dungeon months later still ends on the song forest ends on. That is
    // the whole point - the track becomes part of what a style IS, the way its walls are,
    // instead of a coin flip the player can neither predict nor keep.
    //
    // Which style maps to which song is arbitrary and nobody should try to read meaning into
    // it: the hash has no idea what a forest sounds like. What it guarantees is stability and
    // a flat spread. Adding a track to the end of this list is safe; INSERTING or reordering
    // one silently re-assigns every existing style to a different song, so don't, unless that
    // is what you want.
    //
    // Slots 2-4 are the survivors of a six-way audition, not a guess: generate_victory_candidates
    // in server.py rendered three variations each of victory and victory_synth into
    // sounds/victory_candidates/ for listening, unwired; these three were picked and promoted to
    // real STATIC_MUSIC entries, the other three deleted. See server.py's STATIC_MUSIC for the
    // full history of what has cycled through this pool before (fanfare, folk, serene, grim).
    const VICTORY_MUSIC_TRACKS = [
      'victory',           // 0  warm orchestral march - the original, and the empty-style default
      'victory_synth',     // 1  retro synthwave, the one that isn't an orchestra
      'victory_2',         // 2  variation of 0: brighter/quicker, soaring strings lead
      'victory_synth_2',   // 3  variation of 1: warm analog pads, soaring synth lead
      'victory_synth_3'    // 4  variation of 1: bubbly chiptune arpeggios, square-wave lead
    ];

    // Everything that should NOT change the song, removed: case, spacing, the quote marks that
    // mark a style as a named entity server-side (see currentThemeName), and all punctuation.
    // Letters and digits in order, nothing else - so "Forest", 'forest ', '"forest"' and
    // "FOREST!" are one style, and so are "ice cave", "Ice-Cave" and "icecave".
    //
    // Spacing is stripped rather than collapsed on purpose. A player coming back to a dungeon
    // they liked will not reproduce their own punctuation, and "Windows 95" / "Windows95" is
    // exactly the pair that would otherwise end on two different songs for no reason a player
    // could ever see. Word ORDER still counts: "cave ice" is a different style from "ice cave".
    function themeMusicKey(style) {
      return String(style || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '');
    }

    // FNV-1a over the normalised style. Any stable hash would do; this one is four lines, has
    // no dependencies and scatters short strings (which is all a style ever is) well enough
    // that neighbouring words - "forest", "forests", "forest temple" - land on unrelated
    // tracks instead of clumping. Math.imul keeps the multiply in 32-bit territory, which is
    // what makes it give the same answer in every browser, today and in a year.
    function victoryTrackFor(style) {
      const key = themeMusicKey(style);
      if (!key) return VICTORY_MUSIC_TRACKS[0];   // no style typed: the original victory loop
      let h = 0x811c9dc5;
      for (let i = 0; i < key.length; i++) {
        h ^= key.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
      }
      return VICTORY_MUSIC_TRACKS[(h >>> 0) % VICTORY_MUSIC_TRACKS.length];
    }

    // This run's track, resolved ONCE when the dungeon is entered rather than read off the
    // style at the moment of the win. The style field on the setup screen is live - a player
    // can be typing their next dungeon into it while the History window replays an old one -
    // and the buffer is fetched a whole dungeon before it is needed, so the answer has to be
    // pinned to the run, not to whatever the input happens to say later.
    let runVictoryTrack = VICTORY_MUSIC_TRACKS[0];
    function pickRunVictoryTrack(style) {
      runVictoryTrack = victoryTrackFor(style);
      return runVictoryTrack;
    }

    // Procedural stand-ins. Deliberately crude - shaped noise through a filter with a
    // percussive envelope - because their whole job is to keep the game audible when the
    // generated pack is missing, not to compete with it.
    const SYNTH_SFX = {
      step:         { f: 620,  q: 1.2, dur: 0.11, type: 'lowpass',  gain: 0.30, sweep: 0.55 },
      bump:         { f: 180,  q: 1.0, dur: 0.16, type: 'lowpass',  gain: 0.45, sweep: 0.60 },
      turn:         { f: 500,  q: 1.0, dur: 0.08, type: 'lowpass',  gain: 0.18, sweep: 0.65 },
      attack:       { f: 2400, q: 0.8, dur: 0.20, type: 'bandpass', gain: 0.35, sweep: 0.30 },
      miss_enemy:   { f: 1800, q: 0.6, dur: 0.24, type: 'bandpass', gain: 0.28, sweep: 0.20 },
      block:        { f: 1400, q: 4.0, dur: 0.26, type: 'bandpass', gain: 0.45, sweep: 0.70 },
      miss_player:  { f: 1600, q: 0.6, dur: 0.26, type: 'bandpass', gain: 0.28, sweep: 0.20 },
      hit_enemy:    { f: 420,  q: 1.4, dur: 0.20, type: 'lowpass',  gain: 0.50, sweep: 0.45 },
      hit_player:   { f: 300,  q: 1.4, dur: 0.24, type: 'lowpass',  gain: 0.55, sweep: 0.40 },
      death_enemy:  { f: 260,  q: 2.0, dur: 0.70, type: 'lowpass',  gain: 0.50, sweep: 0.25 },
      death_player: { f: 200,  q: 2.0, dur: 0.90, type: 'lowpass',  gain: 0.60, sweep: 0.20 }
    };

    function synthSfx(name, rate) {
      const ctx = sfxContext();
      if (!ctx) return;
      const cfg = SYNTH_SFX[name] || SYNTH_SFX.step;
      const dur = cfg.dur / (rate || 1);
      const n = Math.max(1, Math.floor(ctx.sampleRate * dur));
      const buf = ctx.createBuffer(1, n, ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < n; i++) {
        // Noise under an exponential decay - the envelope is what makes it read as a hit
        // rather than a hiss.
        d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 2.5);
      }
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const filt = ctx.createBiquadFilter();
      filt.type = cfg.type;
      filt.Q.value = cfg.q;
      const f0 = cfg.f * (rate || 1);
      filt.frequency.setValueAtTime(f0, ctx.currentTime);
      filt.frequency.exponentialRampToValueAtTime(Math.max(40, f0 * cfg.sweep),
                                                  ctx.currentTime + dur);
      const g = ctx.createGain();
      g.gain.value = cfg.gain;
      src.connect(filt); filt.connect(g); g.connect(sfxMaster);
      src.start();
    }

    // Every in-game sound goes through here. `vary` is the pitch/level jitter that stops a
    // corridor of footsteps sounding like one sample on a loop.
    function playSfx(name, opts) {
      if (!sfxOn) return;
      const o = opts || {};
      const vary = o.vary === undefined ? 0.08 : o.vary;
      const rate = (o.rate || 1) * (1 + (Math.random() * 2 - 1) * vary);
      const ctx = sfxContext();
      if (!ctx) return;
      const buf = sfxBank[name];
      if (!buf) { synthSfx(name, rate); return; }
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = rate;
      const g = ctx.createGain();
      g.gain.value = (o.gain === undefined ? 1.0 : o.gain) * (1 + (Math.random() * 2 - 1) * 0.10);
      src.connect(g); g.connect(sfxMaster);
      src.start();
    }

    // The three theme-independent UI sounds, served as static files from sounds/ rather than
    // generated per run. Fetched once and decoded into the same bank, so they play through
    // playSfx like everything else. A 404 (or a checkout without the files) just leaves them
    // absent, and the procedural bank covers them.
    const UI_SOUNDS = ['start', 'button', 'end', 'ready'];
    // The sting that plays the instant the dungeon opens, on a first entry and on a restart
    // from the death box alike. Lowered 15% from full - it was landing louder than the bed
    // it hands off to.
    const START_STING_GAIN = 0.85;
    function loadUiSounds() {
      const ctx = sfxContext();
      if (!ctx) return;
      UI_SOUNDS.forEach(name => {
        if (sfxBank[name]) return;
        fetch(`${SERVER_URL}/sounds/${name}.wav`)
          .then(r => (r.ok ? r.arrayBuffer() : Promise.reject()))
          .then(ab => ctx.decodeAudioData(ab, buf => { sfxBank[name] = buf; }, () => {}))
          .catch(() => { /* falls back to synthSfx */ });
      });
    }

    // An AudioContext created outside a user gesture starts suspended, and resume() only
    // takes inside one. enterDungeon can be reached without a click (the "enter when done
    // loading" checkbox fires it from the poll timer), so rather than relying on any single
    // button, unlock on the first gesture of any kind. Once is enough for the session.
    ['pointerdown', 'keydown'].forEach(evt => {
      window.addEventListener(evt, () => {
        sfxContext(); loadUiSounds(); loadMenuMusic(); loadScreenMusic('loading');
      }, { once: true, capture: true });
    });

    // One delegated click for every Win95 button, rather than a listener per control.
    // Excluded: the D-pad (its buttons already produce a footstep or a wall thud) and the
    // battle action bar (already a swing or a block), where a click on top would double up.
    document.addEventListener('click', (ev) => {
      const btn = ev.target.closest && ev.target.closest('.win95-btn');
      if (!btn) return;
      if (btn.classList.contains('dpad-btn')) return;
      if (btn.closest('#battleActionBar')) return;
      playSfx('button', { vary: 0.03, gain: 0.5 });
    }, true);
    // HUD portrait expressions, in PORTRAIT_FRAME_NAMES order: idle, attack, block, hurt.
    let playerFaceFrames = [];
    let rig = { swordX: 24, swordY: -30, shieldX: -28, shieldY: -32 };

    let MAP = [];
    let MAP_WIDTH = 0;
    let MAP_HEIGHT = 0;
    let visitedTiles = new Set();
    let passagesList = [];
    let lanternList = [];
    // Locked gates on the single start->exit path, and the wall switches that open them.
    // doorList:   [{ x, y, index, opened }]  - x,y is a former connector tile now set to MAP 3
    // switchList: [{ x, y, cellX, cellY, doorIndex, on }] - x,y is a wall tile set to MAP 4/5,
    //             cellX,cellY the floor tile the player stands on to face it.
    // Built by placeGatesAndSwitches() during maze generation; guaranteed solvable.
    let doorList = [];
    let switchList = [];
    // Roaming foes, scattered over the walkable tiles at generation time and drawn in the 3D
    // view as floating billboards (see drawWorldEnemies). Stepping onto one starts its battle;
    // winning clears `alive` and the marker stops being drawn.
    //   [{ x, y, variant, alive, phase }]   phase de-syncs each marker's hover bob.
    let enemyMarkers = [];
    // The marker whose battle is currently running, so the win can retire the right one.
    let activeMarker = null;
    let exitRoom = { x: 5, y: 5 };
    let startRoom = { x: 1, y: 1 };
    let zBuffer = new Float64Array(screenWidth);
    // Per-column vertical extent of the wall the DDA pass drew, so the floor/ceiling pass can
    // skip every pixel a wall is about to cover. See the "Wall Casting" note in render3D.
    let wallTop = new Int32Array(screenWidth);
    let wallBot = new Int32Array(screenWidth);

    // ==========================================
    // LANTERN LIGHTMAP
    // ==========================================
    // Lantern light used to be summed per PIXEL: the floor/ceiling pass walked the whole
    // lanternList with a Math.hypot for every one of the 76,800 pixels, and the wall pass did
    // the same for every column. That is O(pixels * lanterns) per frame - and lanternList
    // grows with the maze, because lanterns are stamped on every third eligible wall tile.
    // Which is exactly why Hard ran slower than Medium and Medium slower than Easy: the maze
    // got bigger, so every pixel got more expensive. Nothing about the light was changing
    // frame to frame; we were recomputing a static field 60 times a second.
    //
    // So bake it once per maze into a grid of samples and read it back with a bilinear tap.
    // Per-pixel cost stops depending on the lantern count entirely, which is what makes the
    // three difficulties render at the same speed.
    //
    // Two fields, because the two surfaces were always lit with different constants: floors
    // and ceilings fall off over 2.8 world units at 0.65 strength, walls over 3.2 at 0.75.
    const LIGHT_SUBDIV = 16;            // samples per map cell, each axis (0.0625 world units)
    const LIGHT_FLOOR_RADIUS = 2.8;
    const LIGHT_FLOOR_GAIN = 0.65;
    const LIGHT_WALL_RADIUS = 3.2;
    const LIGHT_WALL_GAIN = 0.75;
    let lightMapW = 0;
    let lightMapH = 0;
    let floorLightMap = null;
    let wallLightMap = null;

    function buildLightMaps() {
      lightMapW = Math.max(2, MAP_WIDTH * LIGHT_SUBDIV + 1);
      lightMapH = Math.max(2, MAP_HEIGHT * LIGHT_SUBDIV + 1);
      floorLightMap = new Float32Array(lightMapW * lightMapH);
      wallLightMap = new Float32Array(lightMapW * lightMapH);
      // Even a mazeless map gets its (all-zero) buffers, so the samplers never see null.
      if (!lanternList.length) return;

      const wr2 = LIGHT_WALL_RADIUS * LIGHT_WALL_RADIUS;
      for (let li = 0; li < lanternList.length; li++) {
        const lx = lanternList[li].x + 0.5;
        const ly = lanternList[li].y + 0.5;
        // Only the samples inside the LARGER of the two radii can be touched at all, so the
        // bake is O(lanterns * r^2) rather than O(lanterns * map).
        const i0 = Math.max(0, Math.floor((lx - LIGHT_WALL_RADIUS) * LIGHT_SUBDIV));
        const i1 = Math.min(lightMapW - 1, Math.ceil((lx + LIGHT_WALL_RADIUS) * LIGHT_SUBDIV));
        const j0 = Math.max(0, Math.floor((ly - LIGHT_WALL_RADIUS) * LIGHT_SUBDIV));
        const j1 = Math.min(lightMapH - 1, Math.ceil((ly + LIGHT_WALL_RADIUS) * LIGHT_SUBDIV));
        for (let j = j0; j <= j1; j++) {
          const dy = j / LIGHT_SUBDIV - ly;
          const dy2 = dy * dy;
          const row = j * lightMapW;
          for (let i = i0; i <= i1; i++) {
            const dx = i / LIGHT_SUBDIV - lx;
            const d2 = dx * dx + dy2;
            if (d2 >= wr2) continue;
            const d = Math.sqrt(d2);
            wallLightMap[row + i] += (1 - d / LIGHT_WALL_RADIUS) * LIGHT_WALL_GAIN;
            if (d < LIGHT_FLOOR_RADIUS) {
              floorLightMap[row + i] += (1 - d / LIGHT_FLOOR_RADIUS) * LIGHT_FLOOR_GAIN;
            }
          }
        }
      }
    }

    // Bilinear tap into a baked field. Bilinear rather than nearest because a wall column is
    // lit by a single sample: nearest-neighbour would step the brightness in visible 0.125-unit
    // bands across a wall face as the player slid along it.
    function sampleLight(map, wx, wy) {
      if (!map) return 0;
      let fx = wx * LIGHT_SUBDIV;
      let fy = wy * LIGHT_SUBDIV;
      // Rays near the horizon run far outside the map; clamping to the border is correct
      // because the border samples are unlit anyway.
      if (!(fx > 0)) fx = 0; else if (fx > lightMapW - 1.001) fx = lightMapW - 1.001;
      if (!(fy > 0)) fy = 0; else if (fy > lightMapH - 1.001) fy = lightMapH - 1.001;
      const ix = fx | 0;
      const iy = fy | 0;
      const tx = fx - ix;
      const ty = fy - iy;
      const r0 = iy * lightMapW + ix;
      const r1 = r0 + lightMapW;
      const a = map[r0], b = map[r0 + 1], c = map[r1], d = map[r1 + 1];
      const top = a + (b - a) * tx;
      const bot = c + (d - c) * tx;
      return top + (bot - top) * ty;
    }

    let activeMode = 'v6_krea';
    let currentThemeName = "Windows 95";
    let totalMoves = 0;
    let queuedAction = null;

    // The dungeon exactly as the player entered it - MAP tiles, the door/switch latches, the
    // walkable-tile list and the spawn pose, plus the asset bundle so its music can restart.
    // Captured once by enterDungeon(); restartDungeon() rolls the whole run back to it from the
    // death screen without regenerating anything.
    let dungeonSnapshot = null;

    const DIRS = ['NORTH', 'EAST', 'SOUTH', 'WEST'];
    const DIR_VECS = [
      { dx: 0, dy: -1 }, // 0: NORTH
      { dx: 1, dy: 0 },  // 1: EAST
      { dx: 0, dy: 1 },  // 2: SOUTH
      { dx: -1, dy: 0 }  // 3: WEST
    ];

    function dirToAngle(dirIndex) {
      if (dirIndex === 0) return -Math.PI / 2; // NORTH
      if (dirIndex === 1) return 0;            // EAST
      if (dirIndex === 2) return Math.PI / 2;  // SOUTH
      if (dirIndex === 3) return Math.PI;      // WEST
      return 0;
    }

    let player = {
      gridX: 1,
      gridY: 1,
      posX: 1.5,
      posY: 1.5,
      angle: 0,
      dirIndex: 1,
      isAnimating: false
    };

    // ==========================================
    // WINDOW BUTTONS & FULLSCREEN HANDLERS
    // ==========================================
    function toggleFullscreen() {
      if (!document.fullscreenElement) {
        document.documentElement.requestFullscreen().catch(err => console.warn(err));
        btnMaximize.textContent = "❐";
      } else {
        document.exitFullscreen().catch(err => console.warn(err));
        btnMaximize.textContent = "□";
      }
    }

    btnMaximize.addEventListener('click', toggleFullscreen);
    document.addEventListener('fullscreenchange', () => {
      btnMaximize.textContent = document.fullscreenElement ? "❐" : "□";
    });

    // True at the base "nothing playing" screen - Setup normally, or the Showcase gallery in
    // SHOWCASE_MODE, which never shows Setup at all. A handful of spots elsewhere used to read
    // screenSetup's own hidden class directly as a stand-in for "no run is active"; those now
    // call this instead so they keep working with either base screen.
    function atBaseScreen() {
      return SHOWCASE_MODE
        ? !!(screenShowcase && !screenShowcase.classList.contains('hidden'))
        : !screenSetup.classList.contains('hidden');
    }

    // Putting the base screen back up, and clearing it on the way out to the loading screen.
    // Hiding Setup alone is not enough in SHOWCASE_MODE - Setup is already hidden there, so the
    // gallery would sit on screen behind the loading readout.
    function showBaseScreen() {
      if (SHOWCASE_MODE) {
        if (screenShowcase) screenShowcase.classList.remove('hidden');
      } else {
        screenSetup.classList.remove('hidden');
      }
    }

    function hideBaseScreen() {
      screenSetup.classList.add('hidden');
      if (screenShowcase) screenShowcase.classList.add('hidden');
    }

    function openSetupScreen() {
      resetTabTitle();
      screenGame.classList.add('hidden');
      stopOutroNarration();
      // The run's cutscene - playing, held under the box, or still being polled for - goes with
      // it. A background render keeps filming server-side until something else needs ComfyUI.
      resetEndingCutscene();
      // Any leftover "still reading the intro crawl" hold is meaningless back on the menu -
      // clear it so it can't keep the screen saver (idle or ✕-forced) suppressed here.
      crawlReadingUntil = 0;
      currentRunHistoryId = null;
      currentRunFavorite = false;
      // Landing back on the menu from a History replay: put that run's own prompts back into
      // the fields, so what's shown matches what was actually just played instead of whatever
      // draft was sitting there beforehand - and one undo step restores that draft if it was
      // wanted after all. A freshly generated run never sets this: its own prompts are already
      // in the fields, untouched since Create was pressed.
      if (currentRunHistoryPrompts) {
        const prompts = currentRunHistoryPrompts;
        currentRunHistoryPrompts = null;
        asOneSetupStep(() => {
          fillPromptField(wallPromptInput, prompts.wall, null);
          fillPromptField(playerPromptInput, prompts.player, 'player');
          fillPromptField(weaponPromptInput, prompts.weapon, 'weapon');
          fillPromptField(enemyPromptInput, prompts.enemy, 'enemy');
        });
      }
      stopConfetti();
      victoryModal.classList.add('hidden');
      if (defeatModal) defeatModal.classList.add('hidden');
      showBaseScreen();
      if (SHOWCASE_MODE) {
        refreshHistory();        // re-read the manifest so a just-played run's beaten/favorite shows
      } else {
        shuffleQuickIdeas();     // fresh Quick idea order on every return to the menu
      }
      if (titleButtons) titleButtons.classList.remove('hidden');
      appContainer.className = 'win95-box p-1 text-black mode-setup w-full';
      returnToMenuMusic();     // win, lose, or quit - the dungeon's music stops, menu fades in
    }

    // Where a dialog's keyboard cursor starts. `preferred` is the button that box wants
    // under Enter the moment it opens - the safe one, never the destructive one - and the
    // fallback is its first control that isn't the title bar's ✕, which is first in the DOM
    // but is never what someone came to press. Defined here because every open* function
    // below (and the History window further down) calls it.
    function focusFirstIn(root, preferred) {
      if (preferred && !preferred.disabled && preferred.getClientRects().length) {
        preferred.focus({ preventScroll: true });
        return;
      }
      const all = focusablesIn(root);
      const target = all.find(el => !el.closest('.win95-title')) || all[0];
      if (target) target.focus({ preventScroll: true });
    }

    // Quit-confirm box: opened by ESC or the title-bar ✕ during an active run instead of an
    // OS confirm() prompt, since leaving mid-dungeon has real choices, not just yes/no.
    function openQuitConfirm() {
      if (!modalQuitConfirm) { if (confirm("Back to Main Menu?")) openSetupScreen(); return; }
      // Nothing was ever written to disk for this run (a pre-history dungeon, or a save that
      // failed), so there is nothing to erase - and "Back to Main Menu" already discards it.
      // A starred run is locked the same way its trash can in History is: without this the
      // server would refuse the delete and the player would land on the menu thinking it went.
      if (btnQuitEraseRun) {
        const locked = isFavoriteHistoryId(currentRunHistoryId);
        btnQuitEraseRun.disabled = !currentRunHistoryId || locked;
        btnQuitEraseRun.title = !currentRunHistoryId
          ? 'This run was never saved to History, so there is nothing to erase.'
          : locked ? 'This run is a favorite. Unstar it in History to erase it.' : '';
      }
      modalQuitConfirm.classList.remove('hidden');
      focusFirstIn(modalQuitConfirm, btnQuitToMenu);
    }

    function closeQuitConfirm() {
      if (modalQuitConfirm) modalQuitConfirm.classList.add('hidden');
      closeEraseConfirm();
    }

    // Erase-confirm box: "Erase Current Run" never deletes on its own, the same rule the
    // History window's trash can follows. Opens on top of the quit box, so backing out of
    // it lands back on the three choices rather than in the dungeon.
    function openEraseConfirm() {
      if (!modalEraseConfirm) return;
      if (eraseConfirmName) {
        const where = (dungeonStory && dungeonStory.location) || currentThemeName || '';
        eraseConfirmName.textContent = where.trim();
      }
      modalEraseConfirm.classList.remove('hidden');
      focusFirstIn(modalEraseConfirm, btnEraseConfirmCancel);
    }

    function closeEraseConfirm() {
      if (modalEraseConfirm) modalEraseConfirm.classList.add('hidden');
    }

    // Deletes the dungeon currently being played from History, then leaves it - there is
    // nothing left to keep playing once its saved bundle is gone. Best-effort and silent on
    // failure, the same spirit as save_dungeon_session on the server: the player is leaving
    // this run either way, so a failed cleanup costs them nothing they can see.
    async function eraseCurrentRunAndLeave() {
      closeQuitConfirm();
      const id = currentRunHistoryId;
      if (id) {
        try {
          const res = await fetch(`${SERVER_URL}/api/history_delete`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id })
          });
          const data = await res.json().catch(() => ({}));
          if (!data.success) throw new Error(data.error || 'The server refused the delete.');
        } catch (err) {
          console.error('Erase current run error:', err);
        }
      }
      openSetupScreen();
    }

    if (btnQuitConfirmClose) btnQuitConfirmClose.addEventListener('click', closeQuitConfirm);
    if (btnQuitToMenu) btnQuitToMenu.addEventListener('click', () => { closeQuitConfirm(); openSetupScreen(); });
    // Opens History right over the still-running game - deliberately NOT openSetupScreen()
    // first, which would tear the active run down (stop its music/narration, hide the game
    // screen) just to browse. That teardown happens in loadHistoryDungeon() instead, and
    // only once a row's Start button is clicked AND the player has confirmed ending the run
    // it replaces (askLeaveRun); closing History with nothing
    // picked drops straight back into the same run, untouched.
    if (btnQuitToHistory) btnQuitToHistory.addEventListener('click', () => {
      closeQuitConfirm();
      openHistory();
    });
    // Asks first - the erase itself lives behind the confirm box's own Erase button.
    if (btnQuitEraseRun) btnQuitEraseRun.addEventListener('click', openEraseConfirm);
    // Clicking the darkened game visible behind the box backs out the same as its own ✕ -
    // there is deliberately no separate Cancel button (see the HTML comment on the modal).
    if (modalQuitConfirm) {
      modalQuitConfirm.addEventListener('click', (e) => {
        if (e.target === modalQuitConfirm) closeQuitConfirm();
      });
    }

    // Backing out of the erase box returns to the quit box it opened over, so the cursor
    // goes back where it was rather than dropping the player into the dungeon.
    function cancelEraseConfirm() {
      closeEraseConfirm();
      if (modalQuitConfirm && !modalQuitConfirm.classList.contains('hidden')) {
        focusFirstIn(modalQuitConfirm, btnQuitEraseRun);
      }
    }

    if (btnEraseConfirmClose) btnEraseConfirmClose.addEventListener('click', cancelEraseConfirm);
    if (btnEraseConfirmCancel) btnEraseConfirmCancel.addEventListener('click', cancelEraseConfirm);
    if (btnEraseConfirmErase) btnEraseConfirmErase.addEventListener('click', eraseCurrentRunAndLeave);
    if (modalEraseConfirm) {
      modalEraseConfirm.addEventListener('click', (e) => {
        if (e.target === modalEraseConfirm) cancelEraseConfirm();
      });
    }

    btnClose.addEventListener('click', () => {
      if (!screenGame.classList.contains('hidden')) {
        openQuitConfirm();
      } else if (!screenProgress.classList.contains('hidden')) {
        // The loading screen has its own box - one that can actually stop the generation
        // behind it, which is the whole reason the ✕ is up there.
        openLoadingExitConfirm();
      } else {
        // Off the game screen the window's ✕ "closes" it the only way a browser tab can:
        // the Win98 starfield takes the whole screen, exactly as it does after an idle
        // timeout. showScreensaverManually also holds the dismiss-on-input off for a full
        // second, so the mouse coming off the button doesn't blow it straight back away.
        showScreensaverManually();
      }
    });

    // ---- Leaving the loading screen ---------------------------------------
    // Before this the only way off a run being generated was a page reload: the beforeunload
    // warning and the pagehide beacon were the whole cancel path. The loading screen's ✕ (and
    // ESC, which does the same there) asks in-page instead, and the go button makes that same
    // /api/cancel_generation call from a page that stays put. Once ENTER is armed nothing is
    // running any more - the bundle is saved, History can start it again from disk - so the box
    // rewords itself down to what is actually being given up: the spot in the crawl.
    function openLoadingExitConfirm() {
      if (!modalLoadingExitConfirm) return;
      const generating = generationInFlight;
      if (loadingExitTitle) loadingExitTitle.textContent = generating
        ? '⛔ Stop Generating?' : '🚪 Leave the Loading Screen?';
      if (loadingExitIcon) loadingExitIcon.textContent = generating ? '⛔' : '📜';
      if (loadingExitHead) loadingExitHead.textContent = generating
        ? 'Call off the dungeon being generated?'
        : 'Go back to the menu without entering?';
      if (loadingExitText) loadingExitText.textContent = generating
        ? 'ComfyUI drops the prompts still queued and stops the one it is sampling. Nothing is '
          + 'saved, so making this dungeon after all means generating it from the top.'
        : 'This dungeon is already generated and saved. Nothing is lost – the History window '
          + 'starts it again straight from disk, with no generating and no waiting.';
      if (btnLoadingExitStay) btnLoadingExitStay.textContent = generating ? 'Keep Generating' : 'Keep Reading';
      if (btnLoadingExitGo) btnLoadingExitGo.textContent = generating ? 'Stop Generating' : 'Back to Menu';
      modalLoadingExitConfirm.classList.remove('hidden');
      // The cursor starts on the safe button, the same as every other confirm box here.
      focusFirstIn(modalLoadingExitConfirm, btnLoadingExitStay);
    }

    function closeLoadingExitConfirm() {
      if (modalLoadingExitConfirm) modalLoadingExitConfirm.classList.add('hidden');
    }

    function leaveLoadingScreen() {
      closeLoadingExitConfirm();
      const wasGenerating = generationInFlight;
      generationInFlight = false;   // before the fetch: no beforeunload warning on the way out
      stopGenerationTimers();
      if (wasGenerating) {
        // Exactly what the pagehide beacon sends, just from a page that isn't dying. Nothing
        // waits on the reply - the worker unwinds at its next checkpoint and the settling
        // watcher below is what keeps CREATE disabled until ComfyUI is genuinely clear.
        fetch(`${SERVER_URL}/api/cancel_generation`, { method: 'POST' })
          .catch(() => { /* server already gone - there is nothing left to cancel */ });
      }
      resetCrawl();          // stops the narrator and the loading loop, disarms ENTER
      screenProgress.classList.add('hidden');
      openSetupScreen();     // resets the tab title, shows the menu, fades the menu music back in
      if (wasGenerating) watchForSettling();
    }

    if (btnLoadingExitClose) btnLoadingExitClose.addEventListener('click', closeLoadingExitConfirm);
    if (btnLoadingExitStay) btnLoadingExitStay.addEventListener('click', closeLoadingExitConfirm);
    if (btnLoadingExitGo) btnLoadingExitGo.addEventListener('click', leaveLoadingScreen);
    if (modalLoadingExitConfirm) {
      // A click on the darkened crawl behind the box backs out too, same as the other confirms.
      modalLoadingExitConfirm.addEventListener('click', (e) => {
        if (e.target === modalLoadingExitConfirm) closeLoadingExitConfirm();
      });
    }

    btnPlayAgain.addEventListener('click', openSetupScreen);

    // The pick sticks across reloads: a refresh that dropped a Hard player back to Medium would
    // hand them a smaller maze on the next CREATE without a word. Anything stored that is no
    // longer a difficulty (or nothing at all) falls back to Medium inside setDifficulty.
    const DIFFICULTY_KEY = 'comfycrawler.difficulty';

    function setDifficulty(id) {
      if (!DIFFICULTIES[id]) id = 'medium';
      selectedDifficulty = id;
      gridDesc.textContent = DIFFICULTIES[id].desc;
      difficultyRow.querySelectorAll('.difficulty-btn').forEach((btn) => {
        btn.classList.toggle('is-selected', btn.dataset.difficulty === id);
      });
    }

    difficultyRow.addEventListener('click', (e) => {
      const btn = e.target.closest('.difficulty-btn');
      if (!btn) return;
      setDifficulty(btn.dataset.difficulty);
      prefs.set(DIFFICULTY_KEY, selectedDifficulty);
    });
    setDifficulty(prefs.get(DIFFICULTY_KEY));

    // Last Attack Frame's Off / On / Quick / Flip / Mixed row, drawn like the difficulty row: the
    // pick stays pressed in, and like difficulty it sticks across reloads - it is a way of playing
    // being tried out rather than a per-dungeon pick, and a refresh that quietly reset it would
    // cost a whole generation made without the frame. The stored value is the mode's own name, so
    // a pick saved back when the row was only Off / On still loads as what it was.
    const LAST_ATTACK_FRAME_KEY = 'comfycrawler.lastAttackFrame';
    const LAST_ATTACK_FRAME_MODES = ['off', 'on', 'quick', 'flip', 'mixed'];

    // The mode ONE foe plays under - what the AI and drawEnemyBody ask, rather than reading
    // lastAttackFrameMode themselves. Every mode applies to all foes alike except Mixed, which
    // splits them by how they move: ground foes (walker, runts, boss) play Quick and air foes
    // (flyer, fledglings) play Flip. The pack foes follow their `fly` flag like everything else,
    // so runts go with the walker they are recoloured from and fledglings with the flyer.
    function attackFrameModeFor(e) {
      if (lastAttackFrameMode !== 'mixed') return lastAttackFrameMode;
      const cfg = ENEMY_VARIANTS[e.variant] || ENEMY_VARIANTS.walker;
      return cfg.fly ? 'flip' : 'quick';
    }

    // Is a foe that is mid-attack already in its attack pose? `mode` is its attackFrameModeFor.
    // Off, On and Flip raise the pose with the telegraph; Quick holds it back until the blow lands.
    // Mixed plays Quick on the ground with ONE exception, the boss's charge: its pose goes up on
    // the first tick of the run-in (special 'rush', where the attack state starts and the boss
    // starts coming forward) instead of on arrival. The line-up before it stays in the ordinary
    // stance, and so does every other boss attack, which still lands with its pose.
    function attackPoseUp(e, mode) {
      if (e.state !== 'attack' && e.state !== 'telegraph') return false;
      if (mode !== 'quick') return true;
      if (e.state === 'attack' && e.strikeLanded) return true;
      return lastAttackFrameMode === 'mixed' && e.special === 'rush' && e.state === 'attack';
    }

    function setLastAttackFrame(mode) {
      lastAttackFrameMode = LAST_ATTACK_FRAME_MODES.includes(mode) ? mode : 'off';
      if (!lastAttackFrameRow) return;
      lastAttackFrameRow.querySelectorAll('.last-attack-frame-btn').forEach((btn) => {
        const picked = btn.dataset.lastAttackFrame === lastAttackFrameMode;
        btn.classList.toggle('is-selected', picked);
        btn.setAttribute('aria-pressed', picked ? 'true' : 'false');
      });
    }

    if (lastAttackFrameRow) {
      lastAttackFrameRow.addEventListener('click', (e) => {
        const btn = e.target.closest('.last-attack-frame-btn');
        if (!btn) return;
        setLastAttackFrame(btn.dataset.lastAttackFrame);
        prefs.set(LAST_ATTACK_FRAME_KEY, lastAttackFrameMode);
      });
    }
    // Off/On/Quick/Flip are hidden from the settings row for now - Mixed is the only mode on
    // offer, so it's forced here rather than read back from a stored pick made before that.
    setLastAttackFrame('mixed');

    // Ending Video's dropdown and the Off / On row under it - see the ENDING CUTSCENE section for
    // what they drive. Both default to Off and, like difficulty, stick across reloads: a refresh
    // that quietly turned the cutscene off would cost a whole generation made without it. The
    // row (film it in the background while playing) is greyed out while the dropdown is Off,
    // since it has nothing to move off the loading screen - but it keeps its own pick for when
    // the cutscene comes back on.
    // ...except that the background row is hidden and forced Off for now (index.html holds the
    // row behind a `hidden`), so every cutscene is filmed on the loading screen. Flip this back
    // to true to offer it again: the row reappears, the stored pick is read back, and picks start
    // being saved once more. Off while it is false, the stored pick is left untouched, so an
    // earlier On is still there when the option returns.
    const ENDING_BACKGROUND_OFFERED = false;
    const ENDING_VIDEO_KEY = 'comfycrawler.endingVideo';
    const ENDING_BACKGROUND_KEY = 'comfycrawler.endingVideoBackground';
    const endingVideoSelect = document.getElementById('endingVideoSelect');
    const endingBackgroundRow = document.getElementById('endingBackgroundRow');
    const endingBackgroundLabel = document.getElementById('endingBackgroundLabel');
    let endingVideoOn = false;
    let endingBackgroundOn = false;

    function paintEndingOptionRows() {
      if (endingVideoSelect) endingVideoSelect.value = endingVideoOn ? 'on' : 'off';
      // The background row is still a row of buttons - it is hidden, so it was never worth
      // turning into a second dropdown alongside the first.
      if (endingBackgroundRow) {
        endingBackgroundRow.querySelectorAll('button').forEach((btn) => {
          const picked = (btn.dataset.endingBackground === 'on') === endingBackgroundOn;
          btn.classList.toggle('is-selected', picked);
          btn.setAttribute('aria-pressed', picked ? 'true' : 'false');
          btn.disabled = !endingVideoOn;
        });
      }
      if (endingBackgroundLabel) endingBackgroundLabel.classList.toggle('opacity-50', !endingVideoOn);
    }

    function saveEndingOptions() {
      prefs.set(ENDING_VIDEO_KEY, endingVideoOn ? 'on' : 'off');
      if (ENDING_BACKGROUND_OFFERED) prefs.set(ENDING_BACKGROUND_KEY, endingBackgroundOn ? 'on' : 'off');
    }

    if (endingVideoSelect) {
      endingVideoSelect.addEventListener('change', () => {
        endingVideoOn = endingVideoSelect.value === 'on';
        paintEndingOptionRows();
        saveEndingOptions();
      });
    }
    if (endingBackgroundRow) {
      endingBackgroundRow.addEventListener('click', (e) => {
        const btn = e.target.closest('.ending-background-btn');
        if (!btn || btn.disabled) return;
        if (!ENDING_BACKGROUND_OFFERED) return;
        endingBackgroundOn = btn.dataset.endingBackground === 'on';
        paintEndingOptionRows();
        saveEndingOptions();
      });
    }
    // In the showcase export every clip is already rendered and free to play - unlike the live
    // app, where this defaults off because filming one costs ~200s of GPU time per run. Only
    // defaults on when this visitor has never touched the setting themselves; an explicit choice
    // (their own localStorage, from before or from Options) still wins either way.
    {
      const savedEndingVideo = prefs.get(ENDING_VIDEO_KEY);
      endingVideoOn = savedEndingVideo !== null ? savedEndingVideo === 'on' : SHOWCASE_MODE;
    }
    endingBackgroundOn = ENDING_BACKGROUND_OFFERED && prefs.get(ENDING_BACKGROUND_KEY) === 'on';
    paintEndingOptionRows();

    // Ending Video Look: Smooth / Sharp / Pixel - how both movie players blow the small clip up to
    // fill the screen (see createClipScaler). Each player's scaler registers itself in clipScalers
    // when it is built further down, and takes the current pick then; a change here reaches every
    // one of them at once, mid-play included.
    //
    // The row is hidden for now (index.html holds it behind a `hidden`) and every clip is drawn
    // Pixel: hard square pixels, the same way the rest of the dungeon is drawn, so the cutscene
    // does not arrive looking like it came from a different game. Flip ENDING_LOOK_OFFERED back
    // to true to offer the choice again - the row reappears, the stored pick is read back, and
    // picks start being saved once more. While it is false the stored pick is left untouched, so
    // an earlier Smooth or Sharp is still there when the option returns.
    const ENDING_LOOK_OFFERED = false;
    const ENDING_LOOK_KEY = 'comfycrawler.endingVideoLook';
    const ENDING_LOOKS = ['smooth', 'sharp', 'pixel'];
    const ENDING_LOOK_DEFAULT = 'pixel';
    const endingLookRow = document.getElementById('endingLookRow');
    const clipScalers = [];
    let endingLook = ENDING_LOOK_DEFAULT;

    function setEndingLook(look) {
      endingLook = ENDING_LOOKS.includes(look) ? look : ENDING_LOOK_DEFAULT;
      if (endingLookRow) {
        endingLookRow.querySelectorAll('.ending-look-btn').forEach((btn) => {
          const picked = btn.dataset.endingLook === endingLook;
          btn.classList.toggle('is-selected', picked);
          btn.setAttribute('aria-pressed', picked ? 'true' : 'false');
        });
      }
      clipScalers.forEach((scaler) => scaler.setMode(endingLook));
    }

    if (endingLookRow) {
      endingLookRow.addEventListener('click', (e) => {
        const btn = e.target.closest('.ending-look-btn');
        if (!btn || btn.disabled) return;
        if (!ENDING_LOOK_OFFERED) return;
        setEndingLook(btn.dataset.endingLook);
        prefs.set(ENDING_LOOK_KEY, endingLook);
      });
    }
    setEndingLook(ENDING_LOOK_OFFERED ? prefs.get(ENDING_LOOK_KEY) : ENDING_LOOK_DEFAULT);

    // Sound Generation: music+sound / sound only / none (index.html #soundModeSelect). Unlike the
    // other options here, this one had no saved key until model downloads needed somewhere to
    // record "the player unlocked a louder mode" - see raiseSoundMode, which model-group downloads
    // call once their files are in place.
    const SOUND_MODE_KEY = 'comfycrawler.soundMode';
    const SOUND_MODES = ['skip', 'sound_only', 'music_and_sound'];
    if (soundModeSelect && SOUND_MODES.includes(prefs.get(SOUND_MODE_KEY))) {
      soundModeSelect.value = prefs.get(SOUND_MODE_KEY);
    }
    if (soundModeSelect) {
      soundModeSelect.addEventListener('change', () => prefs.set(SOUND_MODE_KEY, soundModeSelect.value));
    }

    // Raises Sound Generation to at least `rank` (0 skip / 1 sound_only / 2 music_and_sound) -
    // never lowers it. Called when a model download unlocks a level the player hadn't already
    // reached, so finishing "Sound effects" or "Music" from the setup screen turns sound on
    // without a trip to Options - see onDownloadJobFinished.
    function raiseSoundMode(rank) {
      if (!soundModeSelect) return;
      const current = Math.max(0, SOUND_MODES.indexOf(soundModeSelect.value));
      if (rank <= current) return;
      soundModeSelect.value = SOUND_MODES[rank];
      prefs.set(SOUND_MODE_KEY, soundModeSelect.value);
    }

    // `focusTarget` is where the cursor starts - the current difficulty button normally (the
    // dialog's first real choice, and a keyboard player wants to see where they already are, not
    // land on OK), the ComfyUI address field when the setup screen's preflight notice opened it.
    // The ComfyUI section reloads on every open, so edits left unapplied by ✕ / ESC last time
    // never reappear as if they had been saved.
    function openSettings(focusTarget) {
      modalSettings.classList.remove('hidden');
      if (!SHOWCASE_MODE) loadComfySettings();   // section is hidden there anyway - nothing to check
      const currentDifficultyBtn = difficultyRow.querySelector('.difficulty-btn.is-selected');
      focusFirstIn(modalSettings, focusTarget || currentDifficultyBtn || btnSaveSettings);
      if (focusTarget && document.activeElement === focusTarget) {
        focusTarget.scrollIntoView({ block: 'nearest' });
      }
    }
    btnSettings.addEventListener('click', () => openSettings());
    const btnShowcaseSettings = document.getElementById('btnShowcaseSettings');
    if (btnShowcaseSettings) btnShowcaseSettings.addEventListener('click', () => openSettings());
    btnCloseSettings.addEventListener('click', () => modalSettings.classList.add('hidden'));
    // OK applies ComfyUI edits that were never applied; if the server refuses them (a malformed
    // address, or a run in progress) Options stays open on the reason instead of losing them.
    btnSaveSettings.addEventListener('click', async () => {
      if (comfyEditsPending()) {
        const saved = await applyComfySettings();
        if (saved === false) {
          const first = Object.values(comfyFields).find((input) => input && !input.disabled);
          if (first) { first.focus({ preventScroll: true }); first.scrollIntoView({ block: 'nearest' }); }
          return;
        }
      }
      modalSettings.classList.add('hidden');
    });

    // About box. Same shape as Options: the ✕, OK, ESC and a click on the darkened menu behind
    // it all back out, and the keyboard cursor starts on OK rather than on the title bar's ✕.
    function closeAbout() { if (modalAbout) modalAbout.classList.add('hidden'); }
    if (btnAbout && modalAbout) {
      btnAbout.addEventListener('click', () => {
        modalAbout.classList.remove('hidden');
        focusFirstIn(modalAbout, btnAboutOk);
        // Section is hidden there anyway - nothing to check, and checkPreflight() has no server
        // to ask in this export.
        if (!SHOWCASE_MODE) refreshAboutModels();
      });
      modalAbout.addEventListener('click', (e) => {
        if (e.target === modalAbout) closeAbout();
      });
    }
    if (btnCloseAbout) btnCloseAbout.addEventListener('click', closeAbout);
    if (btnAboutOk) btnAboutOk.addEventListener('click', closeAbout);

    // ==========================================
    // MAD-LIB UNDO / REDO
    // ==========================================
    // The menu edits the four mad-lib fields and the three image slots as ONE document, not as
    // seven independent controls: a Quick idea rewrites four fields in a click, a History row's
    // Prompts button does the same, and attaching a photo blanks and locks the field under it.
    // The browser's own Ctrl+Z cannot cover any of that - it only knows the single <input> the
    // caret is in - so the click that wiped four filled-in fields had nothing behind it. This
    // stack does, and it survives leaving for a dungeon and coming back, because nothing on the
    // way through clears the fields.
    //
    // Whole states, not diffs. The document is four short strings and three thumbnails, and the
    // thumbnails are stored by reference (the same data URL string every snapshot points at),
    // so a deep stack costs a few hundred small objects - far less than the bookkeeping that
    // storing edits would need.
    const SETUP_HISTORY_MAX = 250;
    // Consecutive keystrokes in one field collapse into a single step while they keep coming;
    // a pause longer than this starts a new one. Same bargain every text editor makes - undo
    // should walk back words and phrases, not individual letters, or 250 steps would only
    // reach back through one sentence.
    const SETUP_BURST_MS = 600;

    // The wall line takes no image, so it has no slot; the other three are wired by the same
    // id convention wireImageAttach uses (<key>PromptInput, <key>ImageBadge, ...).
    const SETUP_TEXT_FIELDS = [
      ['wall', wallPromptInput], ['player', playerPromptInput],
      ['weapon', weaponPromptInput], ['enemy', enemyPromptInput],
    ].filter(([, el]) => el);
    const SETUP_IMAGE_SLOTS = ['player', 'weapon', 'enemy'];

    const btnUndoPrompt = document.getElementById('btnUndoPrompt');
    const btnRedoPrompt = document.getElementById('btnRedoPrompt');

    let setupPast = [];          // states behind the one on screen, oldest first
    let setupFuture = [];        // states undone out of, newest-undone last
    let setupPresent = null;     // what is on screen right now, as a snapshot
    let setupBurstKey = null;    // which run of typing the last edit belonged to
    let setupBurstAt = 0;
    // Set while undo/redo is writing the fields, and while a multi-field action is being
    // gathered into one step - both would otherwise be recorded as changes of their own.
    let setupHistorySuspended = false;

    function snapshotSetup() {
      const snap = { text: {}, images: {} };
      SETUP_TEXT_FIELDS.forEach(([key, el]) => { snap.text[key] = el.value; });
      SETUP_IMAGE_SLOTS.forEach((key) => {
        const url = attachedImages[key];
        const nameEl = document.getElementById(key + 'ImageName');
        snap.images[key] = url ? { url, name: nameEl ? nameEl.textContent : '' } : null;
      });
      return snap;
    }

    // Field by field rather than JSON.stringify: this runs on every keystroke, and stringifying
    // a snapshot would serialise up to three half-megabyte data URLs to compare four words.
    // The url strings are shared between snapshots, so those comparisons are pointer-cheap.
    function sameSetup(a, b) {
      if (!a || !b) return false;
      for (const [key] of SETUP_TEXT_FIELDS) if (a.text[key] !== b.text[key]) return false;
      for (const key of SETUP_IMAGE_SLOTS) {
        const x = a.images[key], y = b.images[key];
        if (!x !== !y) return false;
        if (x && (x.url !== y.url || x.name !== y.name)) return false;
      }
      return true;
    }

    // Put a snapshot back on screen. Image state lives in three places at once - attachedImages,
    // the badge DOM, and the disabled flag on the field beneath it - so all three are rewritten
    // from the one record here, exactly as attach and clear write them by hand.
    function applySetupSnapshot(snap) {
      SETUP_TEXT_FIELDS.forEach(([key, el]) => { el.value = snap.text[key] || ''; });
      SETUP_IMAGE_SLOTS.forEach((key) => {
        const img = snap.images[key];
        const badge = document.getElementById(key + 'ImageBadge');
        const thumb = document.getElementById(key + 'ImageThumb');
        const nameEl = document.getElementById(key + 'ImageName');
        const fileInput = document.getElementById(key + 'FileInput');
        const promptInput = document.getElementById(key + 'PromptInput');
        attachedImages[key] = img ? img.url : null;
        if (key === 'player') uploadedPlayerImageDataUrl = attachedImages[key];
        if (thumb) thumb.src = img ? img.url : '';
        if (nameEl) nameEl.textContent = img ? img.name : '';
        if (badge) badge.classList.toggle('hidden', !img);
        // An <input type=file> holds on to the last file picked. Clearing it when the slot ends
        // up empty means picking that same photo again still fires a change event.
        if (fileInput && !img) fileInput.value = '';
        if (promptInput) promptInput.disabled = !!img;
      });
    }

    // The yellow wash a refilled field gets, shared with the History window's Prompts button -
    // one convention for "this field just changed without you typing in it". Restarting it means
    // stripping the class and forcing the style to settle before adding it back, or a second
    // undo in a row would land on a field already mid-animation and show nothing.
    function flashPromptField(input) {
      if (!input) return;
      input.classList.remove('prompt-refilled');
      void input.offsetWidth;
      input.classList.add('prompt-refilled');
      input.addEventListener('animationend',
        () => input.classList.remove('prompt-refilled'), { once: true });
    }

    function updateUndoRedoButtons() {
      if (btnUndoPrompt) {
        const n = setupPast.length;
        btnUndoPrompt.disabled = !n;
        btnUndoPrompt.title = n
          ? 'Undo (Ctrl+Z) - ' + n + ' change' + (n === 1 ? '' : 's') + ' to walk back'
          : 'Nothing to undo yet';
      }
      if (btnRedoPrompt) {
        const n = setupFuture.length;
        btnRedoPrompt.disabled = !n;
        btnRedoPrompt.title = n
          ? 'Redo (Ctrl+Y) - ' + n + ' change' + (n === 1 ? '' : 's') + ' to put back'
          : 'Nothing to redo yet';
      }
    }

    // `burstKey` names the run of typing this edit belongs to. The same key again within
    // SETUP_BURST_MS folds into the step already in progress instead of adding another; null
    // means "this one stands alone", which is what every non-typing edit passes.
    function recordSetupChange(burstKey) {
      if (setupHistorySuspended) return;
      const next = snapshotSetup();
      if (sameSetup(next, setupPresent)) return;
      const now = Date.now();
      const continues = burstKey && burstKey === setupBurstKey && (now - setupBurstAt) < SETUP_BURST_MS;
      if (!continues && setupPresent) {
        setupPast.push(setupPresent);
        // Oldest step falls off the back rather than the stack growing without limit. 250 is
        // deep enough that nothing a player does at this menu in one sitting reaches the end.
        if (setupPast.length > SETUP_HISTORY_MAX) setupPast.shift();
      }
      setupPresent = next;
      setupFuture.length = 0;   // editing after an undo abandons what was undone
      setupBurstKey = burstKey || null;
      setupBurstAt = now;
      updateUndoRedoButtons();
      syncFillInLabel();
    }

    // Run a multi-field action - a Quick idea, a History refill - as a single undo step
    // instead of one per field it happens to touch on the way.
    function asOneSetupStep(fn) {
      if (setupHistorySuspended) { fn(); return; }   // already inside one; that step owns this
      setupHistorySuspended = true;
      try { fn(); } finally { setupHistorySuspended = false; }
      recordSetupChange(null);
    }

    function stepSetupHistory(from, to) {
      if (!from.length) return;
      const before = setupPresent;
      to.push(before);
      setupPresent = from.pop();
      setupHistorySuspended = true;
      try { applySetupSnapshot(setupPresent); } finally { setupHistorySuspended = false; }
      setupBurstKey = null;     // the next keystroke starts a fresh run, never joins the old one
      updateUndoRedoButtons();
      syncFillInLabel();

      // Show what moved. Undo is usually pressed from the button at the bottom of the screen,
      // with the fields it rewrote some way up it, so every field that changed flashes and the
      // first one takes the caret - landing the player where the text they can now keep editing
      // actually is. An image-only step changes no text and leaves the focus alone.
      let firstChanged = null;
      SETUP_TEXT_FIELDS.forEach(([key, el]) => {
        if (before && before.text[key] === setupPresent.text[key]) return;
        flashPromptField(el);
        if (!firstChanged && !el.disabled) firstChanged = el;
      });
      if (firstChanged) {
        firstChanged.focus({ preventScroll: true });
        const end = firstChanged.value.length;
        firstChanged.setSelectionRange(end, end);
      }
    }

    function undoSetup() { stepSetupHistory(setupPast, setupFuture); }
    function redoSetup() { stepSetupHistory(setupFuture, setupPast); }

    // Keeps the button below reading "Fill-in" while any mad-lib field is still empty, and
    // "Randomize all" once every one of them already has something in it to replace - called
    // from every place above that can change a field (typing, undo/redo; Quick idea/History
    // Prompts/image attach all end in recordSetupChange too). Self-contained (its own DOM
    // lookups, and fillInFlight/fillInNoticeTimer are declared further down the file) rather
    // than closing over anything from the button's own wiring, since this runs long before that
    // wiring exists in source order - see the call sites above for why that is still safe: none
    // of them can fire until the whole script, that wiring included, has already run once.
    // Skipped mid-request or while a result/error is flashing on the button; both put the right
    // label back themselves when they are done.
    function syncFillInLabel() {
      if (typeof fillInFlight !== 'undefined' && (fillInFlight || fillInNoticeTimer)) return;
      const btn = document.getElementById('btnFillIn');
      if (!btn) return;
      const label = btn.querySelector('span');
      // A field with a photo attached is disabled and stands as already answered - the photo -
      // same rule Fill-in itself uses, so attaching a photo to every field also flips this.
      const allFilled = SETUP_TEXT_FIELDS.every(([, el]) => el.disabled || el.value.trim());
      if (label) label.textContent = allFilled ? '🔀 Randomize all' : '🔮 Fill-in';
      btn.title = allFilled
        ? 'Every field is filled in - randomize all four'
        : "Fill in every empty field to go with what you've typed";
      if (endingManualFilming()) btn.title = ENDING_FILMING_LOCK_TITLE;
    }

    SETUP_TEXT_FIELDS.forEach(([key, el]) => {
      el.addEventListener('input', (e) => {
        const type = e.inputType || '';
        const prev = setupPresent ? setupPresent.text[key] : '';
        // Anything that takes out more than one character in a single event - select-all and
        // Delete, a cut, a drag-out, a paste over a selection - is the exact accident this
        // feature exists to rescue, so it becomes a step of its own instead of disappearing
        // into the run of typing before it. Only plain typing and single backspaces collapse.
        const bulk = el.value.length < prev.length - 1;
        const typing = type.startsWith('insertText') || type.startsWith('deleteContent');
        const burst = (typing && !bulk)
          ? 'type:' + key + ':' + (type.startsWith('delete') ? 'del' : 'ins')
          : null;
        recordSetupChange(burst);
      });
      // Leaving a field ends its run of typing: coming back to it later is a new step, however
      // quickly the player gets there.
      el.addEventListener('blur', () => { setupBurstKey = null; });
    });

    if (btnUndoPrompt) btnUndoPrompt.addEventListener('click', undoSetup);
    if (btnRedoPrompt) btnRedoPrompt.addEventListener('click', redoSetup);

    // Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y (and the Cmd versions), on the menu only. This deliberately
    // takes the shortcut away from the browser's per-field undo rather than living alongside it:
    // the native one would restore text that this stack never hears about, leaving the two
    // disagreeing about what the document is, and it cannot reach the edits that matter here
    // anyway - a Quick idea, an attached photo, a field wiped by something the player clicked.
    window.addEventListener('keydown', (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const key = (e.key || '').toLowerCase();
      const isUndo = key === 'z' && !e.shiftKey;
      const isRedo = key === 'y' || (key === 'z' && e.shiftKey);
      if (!isUndo && !isRedo) return;
      if (screenSetup.classList.contains('hidden')) return;
      if (topmostOpenDialog()) return;   // the Options/History boxes have their own fields
      e.preventDefault();
      (isUndo ? undoSetup : redoSetup)();
    });

    // The baseline every undo walks back towards: the menu as it loads, before a word is typed.
    setupPresent = snapshotSetup();
    updateUndoRedoButtons();

    // Each quick idea fills in the whole setup - dungeon look plus the player, weapon and
    // enemy - so one click gives a coherent theme instead of just a wall style. Fields that
    // are locked to an uploaded image are left alone.
    const PRESET_IDEAS = {
      // "stick of computer RAM", not "stick of ram": lowercase "ram" is a male sheep, and the
      // generator drew exactly that - a brawny humanoid brute. Verified side by side on the
      // same prompt: "stick of ram" -> an animal, "stick of computer RAM" -> a DDR module.
      'Windows 95 3D maze': { player: 'guy in a shirt and tie with thick glasses', weapon: 'computer keyboard',     enemy: 'stick of computer RAM' },
      'Deep Forest': { player: 'druid in leaf armor',                        weapon: 'living oak staff',              enemy: 'moss-covered dire bear' },
      'Cyber Neon':  { player: 'chrome street samurai in a neon jacket',      weapon: 'glowing plasma katana',        enemy: 'rogue security drone' },
      'Mossy Stone': { player: 'lichen-cloaked stone knight',                weapon: 'moss-covered stone warhammer', enemy: 'crumbling gargoyle golem' },
      'Candy Cane':  { player: 'gingerbread paladin with frosting armor',    weapon: 'peppermint candy cane staff',  enemy: 'gummy bear' },
      'Tacos':       { player: 'masked luchador chef',                       weapon: 'sizzling cast-iron skillet',   enemy: 'taco' },
      'Haunted Manor':   { player: 'victorian ghost hunter',                  weapon: 'silver-tipped cane',           enemy: 'poltergeist in a torn dress' },
      'Volcanic Depths': { player: 'ash-scarred fire dwarf in obsidian mail', weapon: 'molten iron greataxe',         enemy: 'lumbering magma golem' },
      'Sunken Ruins':    { player: 'coral-armored deep diver',                weapon: 'barnacled bronze trident',     enemy: 'tentacled kraken spawn' },
      "Pharaoh's Tomb":  { player: 'bandaged tomb raider in linen wraps',     weapon: 'golden khopesh sword',         enemy: 'shambling scarab-covered mummy' },
      'internet':        { player: 'cat',                     weapon: 'cat memes',            enemy: 'chat' },
      'trippy':          { player: 'pink and green cat',      weapon: 'skateboard',       enemy: 'business cat' },
      'classroom':       { player: 'nun',                     weapon: 'ruler',            enemy: 'devil' },
      'cut up fruit':    { player: 'watermelon',              weapon: 'fat cat',          enemy: 'blueberries with guns' },
      'birds':           { player: 'fluffy white cat',        weapon: 'long banana',      enemy: 'dinosaurs' },
      'corporate office':{ player: 'dog',                     weapon: 'office supply',    enemy: 'office furniture' },
      // The quotes are deliberate: they push the wall theme down the named-entity path so it
      // renders the real city, not a "manhattan"-shaped bucket. The data-val is &quot;-encoded
      // in index.html and the browser hands us the quoted string, so the key must include them.
      '"manhattan"':     { player: 'rat',                     weapon: 'pizza',            enemy: 'everything bagel with cheese' },
      '"hell"':            { player: '"Rachel" lady reporter',           weapon: 'baseball bat',     enemy: '"Donald Trump"' },
      'motherboard':     { player: 'colorful anime fluffy cat', weapon: 'halberd',          enemy: 'anime villainess' },
      'pet store':       { player: 'Yorkshire Terrier',       weapon: 'whip',             enemy: 'bright stuffed animal' },
      'Sega arcade':     { player: '"Goodcow" the cow',       weapon: 'Dreamcast controller', enemy: '"Sonic"' },
      'supermarket':     { player: 'cashier',                 weapon: 'shopping basket',  enemy: 'old person' },
      'corn maze':       { player: 'pickup truck robot',      weapon: 'pitchfork',        enemy: 'zombie animal' },
      'pizza toppings':  { player: 'cat chef',                weapon: 'pepperoni',        enemy: 'pasta' },
      '"central park"':  { player: 'colorful rollerskater woman', weapon: 'tree branch with leaves', enemy: 'cardboard box man' },
      // Quotes push each name down the named-entity path (same as "Sonic" / "Donald Trump"
      // above) so they draw the real characters. Yoshi as the weapon = you ride him.
      'mushrooms':       { player: '"Mario"',                 weapon: '"Yoshi"',          enemy: '"Bowser"' },
      // Quotes on the person for the same reason as "Donald Trump" under hell: they push the
      // enemy down the named-entity path so it draws the real man, not an "elon"-shaped bucket.
      // "wearing ..." is an attributive joiner _theme_enemy_subject may trim back to just the
      // name - the jacket is a bonus, not load-bearing.
      'outer space':     { player: 'Doge',                    weapon: 'drugs',            enemy: '"Elon Musk" wearing a ketamine jacket' },
      // Quotes on the wall, player, and enemy push all three down the named-entity path (same
      // reasoning as manhattan/Sonic/Mario/Elon Musk above): the wall renders the real store,
      // not a generic "apple store"-shaped bucket, and the player/enemy draw the real man and
      // the real character.
      '"Apple Store"':   { player: '"Steve Jobs"',            weapon: 'sledgehammer',     enemy: '"Clippy" the giant paperclip creature with two googly eyes' },
      'NYC subway station': { player: 'MTA conductor',        weapon: 'huge MetroCard',   enemy: 'NYC subway train' },
      // Quotes on the player only: "Will Smith" pushes him down the named-entity path (same
      // reasoning as Steve Jobs/Donald Trump/Elon Musk above) so it draws the real actor, while
      // the fork and spaghetti monster are generic buckets like the other food-themed ideas.
      'italian restaurant': { player: '"Will Smith"',         weapon: 'huge fork',        enemy: 'spaghetti monster' },
      // Deliberately unresolved: the quotes sit on the game, not on a character, so each field
      // is "something from Dark Souls" and the generator picks a different knight, blade and
      // horror every run instead of always drawing the one character a fixed name would pin it to.
      '"Dark Souls"':    { player: 'Person from "Dark Souls"', weapon: 'weapon from "Dark Souls"', enemy: 'enemy from "Dark Souls"' },
      '"Demon\'s Souls"': { player: '"Patches"',              weapon: '"Rivers of Blood" katana', enemy: 'Barney the dinosaur' },
      'World of Warcraft': { player: 'Night Elf',             weapon: 'sentinel glaive',  enemy: 'Elf on a shelf' },
      'PlayStation':       { player: '"Solid Snake"',         weapon: 'yellow Stun Baton', enemy: '"Donkey Kong"' },
      'Doom 2':            { player: 'Doom guy',              weapon: 'chainsaw',         enemy: '"Thomas the Tank Engine"' },
      'GTA Vice City':     { player: '"Carl Johnson"',        weapon: 'golf club',        enemy: '"Teletubby"' },
      'Colorful town of "Mow Meow"': { player: '"Salescat" the colorful cat', weapon: 'ryobi lawnmower', enemy: 'grass' },
      'Mixer streaming platform': { player: 'The most like omg popular streamer', weapon: 'Elgato Stream Deck', enemy: 'troll doll' },
      // Quotes on the wall and player push both down the named-entity path (same reasoning as
      // manhattan/Sonic/Elon Musk above): the wall renders the real mascot's forest and the
      // player draws Smokey himself, rather than a generic "bear" bucket.
      '"Smokey the bear" forest': { player: '"Smokey the bear"', weapon: 'fire extinguisher', enemy: 'fire pokemon' },
      // Secret 30th idea - see the shuffle-unlock block below. Not a named preset: "LSD dream
      // emulator" hits the lsddream bucket in _STYLE_BUCKETS_NAMED (server.py) on its own, so
      // the wall renders the game's PS1-collage look untouched, no quotes needed.
      'LSD dream emulator': { player: 'Gray Man with hat',    weapon: 'colorful Zweihänder', enemy: 'smiling faces' },
      // Secret 31st idea, unlocked later than the one above - see data-unlock-at in index.html.
      // Quotes on the wall and player push both down the named-entity path (same reasoning as
      // manhattan/Sonic/Elon Musk above): the wall renders the real city and the player draws
      // the real figure, rather than a generic bucket.
      '"Rome"': { player: '"Jesus"', weapon: 'cross', enemy: 'balaclava wearing people with tactical law enforcement gear' },
      'Tokyo Tower': { player: 'anime fluffy cat', weapon: 'ramen spoon', enemy: '"Sailor Moon"' },
      'craigslist':  { player: 'good waifu',        weapon: 'crowbar',    enemy: 'anime trope' },
    };

    function bindPresetButton(btn) {
      btn.addEventListener('click', () => {
        const val = btn.getAttribute('data-val');
        // All four fields go down as one undo step, so walking a Quick idea back restores
        // whatever was typed before it in a single Ctrl+Z rather than four.
        asOneSetupStep(() => {
          wallPromptInput.value = val.toLowerCase();
          const idea = PRESET_IDEAS[val];
          if (idea) {
            if (playerPromptInput && !playerPromptInput.disabled) playerPromptInput.value = idea.player;
            if (weaponPromptInput && !weaponPromptInput.disabled) weaponPromptInput.value = idea.weapon;
            if (enemyPromptInput && !enemyPromptInput.disabled) enemyPromptInput.value = idea.enemy;
          }
        });
        // Don't leave the focus ring stranded on a preset deep in the grid. Landing it on
        // the first field lets the player read down the filled-in mad-lib from the top, and
        // Enter from a field still fires CREATE - so "pick an idea, press Enter" still goes.
        wallPromptInput.focus({ preventScroll: true });
      });
    }

    document.querySelectorAll('.preset-btn').forEach(bindPresetButton);

    // Reshuffle the Quick idea grid every time the player lands on the menu - first load and
    // every trip back through openSetupScreen() - so it reads as a rotating grab-bag of
    // suggestions instead of a fixed list, with a different idea catching the eye each visit.
    // Windows 95 stays pinned first: it is the signature look and the default every bare
    // "3D maze" run falls back to.
    //
    // `reroll` is the 🎲 button rather than a visit to the menu, and it is the one case that
    // shuffles Windows 95 in with everything else - the pin exists so the signature look is
    // always THERE on arrival, not so it can never be traded away when the player is explicitly
    // asking for a different handful.
    function shuffleQuickIdeas(reroll) {
      const row = document.getElementById('quickIdeasRow');
      if (!row) return;
      const btns = Array.from(row.querySelectorAll('.preset-btn'));
      const isWin95 = b => b.getAttribute('data-val') === 'Windows 95 3D maze';
      const pinned = reroll ? [] : btns.filter(isWin95);
      const rest = reroll ? btns.slice() : btns.filter(b => !isWin95(b));
      for (let i = rest.length - 1; i > 0; i--) {   // Fisher-Yates over the un-pinned ideas
        const j = Math.floor(Math.random() * (i + 1));
        [rest[i], rest[j]] = [rest[j], rest[i]];
      }
      // appendChild moves the existing node rather than cloning it, so every button keeps the
      // click handler bound just above; re-appending in order is all it takes to reorder the
      // flex-wrap grid. Arrow-key nav is geometric (see moveFocusIn) so it follows along.
      // The "Quick ideas:" label and the 🎲 button are not .preset-btn, so they are never
      // re-appended and stay at the head of the row.
      [...pinned, ...rest].forEach(b => row.appendChild(b));
      trimQuickIdeasToTwoRows(row);
    }

    // Show only the ideas that fit in two rows and hide the rest. The whole list is 29 deep and
    // wrapping all of it walked the CREATE button off the bottom of the window; two rows is
    // enough to read as a grab-bag while leaving the mad-lib fields the space.
    //
    // Which buttons those are can only be known AFTER flex-wrap has placed them - the labels are
    // all different widths and the row is as wide as the window - so this measures rather than
    // counts. Every top is read before anything is hidden: hiding pulls the later buttons up, so
    // measuring and mutating in the same pass would read positions that no longer exist.
    // Everything is unhidden first, so a reshuffle is measured against the full list rather than
    // against whatever the last one happened to leave showing.
    function trimQuickIdeasToTwoRows(row) {
      const btns = Array.from(row.querySelectorAll('.preset-btn'));
      btns.forEach(b => b.classList.remove('hidden'));
      const tops = btns.map(b => b.offsetTop);
      const rows = [...new Set(tops)].sort((a, b) => a - b);
      // One row, two rows, or the menu is off screen entirely (every offsetTop reads 0, so this
      // collapses to a single row and nothing is touched) - either way there is nothing to trim.
      if (rows.length > 2) btns.forEach((b, i) => { if (tops[i] > rows[1]) b.classList.add('hidden'); });
      // The CSS clip that stops the untrimmed list from flashing on first paint (see
      // .quick-ideas-preflash-clip in index.html) has done its job the moment real .hidden
      // classes are in place - drop it so it can't clip a legitimately tall row later (e.g. a
      // long label wrapping to two lines). Every reshuffle from here on is one synchronous
      // unhide-measure-rehide with nothing in between for the browser to paint, so there's
      // nothing left for the clip to guard against.
      row.classList.remove('quick-ideas-preflash-clip');
    }

    // ---- Secret quick ideas: unlocked one at a time after enough dice rolls --------
    // Each secret idea ships as .preset-btn-secret with its own data-unlock-at (index.html),
    // which shuffleQuickIdeas and trimQuickIdeasToTwoRows above never see - only .preset-btn.
    // Once the player has clicked 🎲 enough times to reach a given button's own threshold, it's
    // promoted to a real .preset-btn and joins the rotation for good - the others stay hidden
    // until their own count is reached. The count is a set-once counter that sticks across
    // reloads, same storage pattern as SCREENSAVER_STOP_KEY further down.
    const SHUFFLE_IDEAS_COUNT_KEY = 'comfycrawler.shuffleIdeasCount';
    // Fallback only, for a secret button that ships without its own data-unlock-at.
    const SECRET_IDEA_DEFAULT_UNLOCK_AT = 42;

    function loadShuffleIdeasCount() {
      const n = parseInt(prefs.get(SHUFFLE_IDEAS_COUNT_KEY), 10);
      return Number.isNaN(n) || n < 0 ? 0 : n;
    }

    function saveShuffleIdeasCount(n) {
      prefs.set(SHUFFLE_IDEAS_COUNT_KEY, String(n));
    }

    let shuffleIdeasCount = loadShuffleIdeasCount();

    function unlockSecretIdeasIfEarned() {
      document.querySelectorAll('.preset-btn-secret').forEach(btn => {
        const unlockAt = parseInt(btn.getAttribute('data-unlock-at'), 10) || SECRET_IDEA_DEFAULT_UNLOCK_AT;
        if (shuffleIdeasCount < unlockAt) return;
        btn.classList.remove('preset-btn-secret', 'hidden');
        btn.classList.add('preset-btn');
        bindPresetButton(btn);
      });
    }
    unlockSecretIdeasIfEarned();   // already earned in a past session - unlock on arrival too

    const btnShuffleIdeas = document.getElementById('btnShuffleIdeas');
    if (btnShuffleIdeas) {
      btnShuffleIdeas.addEventListener('click', () => {
        shuffleIdeasCount++;
        saveShuffleIdeasCount(shuffleIdeasCount);
        unlockSecretIdeasIfEarned();
        shuffleQuickIdeas(true);
      });
    }

    // The trim is measured against the window's width, so a resize invalidates it - re-run it
    // (keeping the current order; this is not a reshuffle) once the dragging settles.
    let quickIdeasResizeTimer = 0;
    window.addEventListener('resize', () => {
      clearTimeout(quickIdeasResizeTimer);
      quickIdeasResizeTimer = setTimeout(() => {
        const row = document.getElementById('quickIdeasRow');
        if (row) trimQuickIdeasToTwoRows(row);
      }, 150);
    });

    shuffleQuickIdeas();

    // Land the cursor in STYLE on first paint, same as a Quick idea click or a History
    // "Prompts" apply does further down - a keyboard player can start typing, or arrow
    // straight into CHARACTER/WEAPON/ENEMY, with no click needed first.
    if (wallPromptInput) wallPromptInput.focus({ preventScroll: true });

    // ==========================================
    // VALBRACE REAL-TIME COMBAT ENGINE (v5)
    // ==========================================
    const doomFaceCanvas = document.getElementById('doomFaceCanvas');
    const doomFaceCtx = doomFaceCanvas ? doomFaceCanvas.getContext('2d') : null;
    const battleActionBar = document.getElementById('battleActionBar');
    // The battle bar and the D-pad share one slot in the controls panel - exactly one of them
    // is on screen at a time, which keeps the sidebar (and so the window) a fixed height.
    const dpadGrid = document.getElementById('dpadGrid');
    const battleModeBadge = document.getElementById('battleModeBadge');
    // Replaced with the story's hero name as soon as the crawl lands; falls back to the
    // generic label for legacy modes that never generate a story.
    const heroStatusLabel = document.getElementById('heroStatusLabel');
    const HERO_STATUS_DEFAULT = 'WARRIOR STATUS:';

    function applyHeroStatusLabel() {
      if (!heroStatusLabel) return;
      const hero = (dungeonStory && dungeonStory.hero || '').trim();
      heroStatusLabel.textContent = hero ? (hero.toUpperCase() + ':') : HERO_STATUS_DEFAULT;
    }

    const playerHpBar = document.getElementById('playerHpBar');
    const playerHpText = document.getElementById('playerHpText');
    const playerStmBar = document.getElementById('playerStmBar');
    const playerStmText = document.getElementById('playerStmText');
    const playerXpBar = document.getElementById('playerXpBar');
    const playerXpText = document.getElementById('playerXpText');
    const playerLevelBadge = document.getElementById('playerLevelBadge');
    const encounterBadge = document.getElementById('encounterBadge');
    const controlsHeader = document.getElementById('controlsHeader');

    const levelUpModal = document.getElementById('levelUpModal');
    const levelUpLevelText = document.getElementById('levelUpLevelText');
    const levelUpChoices = document.getElementById('levelUpChoices');

    // ==========================================
    // LEVELLING
    // ==========================================
    // The base bars every run starts from. playerMaxHp / playerMaxStm are BASE + the bonuses
    // banked by SURVIVAL / STAMINA picks, recomputed by applyProgressionStats() - so resetting
    // progression really does put the bars back where a fresh hero starts.
    const BASE_MAX_HP = 100;
    const BASE_MAX_STM = 100;

    // What one action costs, named because the EXHAUSTION visuals key off them: below
    // ATTACK_STM_COST the hero can no longer swing, and at BLOCK_STM_FLOOR the guard drops too -
    // at which point there is nothing left they can do but shuffle sideways, and they are drawn
    // to look it (see combatState.exhaustion).
    const ATTACK_STM_COST = 30;
    const BLOCK_STM_FLOOR = 2;
    // Where in the swing the blade actually connects. attackFrame no longer steps by exactly 1
    // (SPEED picks scale it), so this is tested as a CROSSING - the frame the counter goes from
    // below it to at-or-past it - rather than an equality that a fractional step would skip.
    const ATTACK_HIT_FRAME = 7;
    // OVEREXERTION. A swing taken with something in the bar but less than ATTACK_STM_COST is
    // allowed - it is the desperation option, not a refusal - and it is paid for with the whole
    // remainder plus this long with the bar HELD at zero: no regen, no guard, and a strafe cut
    // to EXHAUSTED_STRAFE_SPEED. 120 sim steps is 2 seconds at the fixed 60fps tick.
    const EXHAUST_LOCK_FRAMES = 120;
    // What is left of the 3.8px/frame strafe once the bar is empty. Moving is the only thing an
    // exhausted hero can still do at all, so it is slowed rather than taken away - at 40% they
    // can still crawl out of a boss's reach, just not out-pace its 0.8px/frame hunt by much.
    const EXHAUSTED_STRAFE_SPEED = 1.5;
    // A raised guard halves whatever the strafe is worth that frame. Blocking was previously
    // free movement-wise - hold S, shuffle at full speed, absorb everything - so the shield is
    // now a real commitment: you give up half your spacing for the frames you hold it. Applied
    // AFTER the SPEED multiplier, so a fast hero still shuffles faster behind their guard than
    // a slow one; they just give up the same half of it.
    const GUARD_STRAFE_FACTOR = 0.5;

    // What each foe is worth. Roughly proportional to how long it takes to put down: the boss
    // has 2.4x the walker's HP and hits hardest, the flyer spends most of the fight out of
    // reach. A maze holds ~4-14 markers (see placeEnemyMarkers), so clearing a whole dungeon
    // is worth ~150-350 XP - three to four levels.
    // The two pack foes are worth less each because you fight three / two of them: a swarm
    // pays 3x10 = 30 and a wing 2x12 = 24. The swarm sits above the walker it is built from
    // because it hits about 1.6x as hard and has more HP between the three of them; the wing
    // sits BELOW the flyer it is built from, despite being two creatures, because its circle
    // hands the player an opening roughly every 1.6s against the flyer's 2.9s and it goes
    // down in a fifth of the time.
    const ENEMY_XP = { walker: 22, flyer: 28, boss: 60, swarmer: 10, circler: 12 };

    // 40 to reach level 2, then 30 more each time: 40 / 70 / 100 / 130... Two walkers make the
    // first level, and the curve outruns a single dungeon's supply by about level 5.
    function xpForLevel(level) { return 40 + (level - 1) * 30; }

    const LEVEL_GAINS = { strength: 4, stamina: 20, survival: 20, speed: 8 };
    // SPEED is banked as a PERCENTAGE and spent as one multiplier on four separate things: the
    // strafe (guarded or not), how fast a swing plays out, stamina regen, and the exploration
    // step tween. Each is small on its own - which is why +8% is worth taking against a flat
    // +20 max health - but they compound: faster regen plus a faster swing is meaningfully more
    // damage per second, not just a snappier animation.
    //
    // Capped, because the enemy AI is tuned against a 3.8px/frame strafe and a 0.8px/frame hunt
    // has to stay able to close. 1.6x is eight picks - further than a single run gets - so the
    // ceiling exists for the pathological case rather than as a wall the player feels.
    const SPEED_MAX_MULT = 1.6;
    // Every level also patches the hero up, whichever path they take. Without it the run is
    // decided by the first two fights - there is no other healing in the dungeon.
    const LEVEL_HEAL_FRAC = 0.4;

    const progression = {
      level: 1,
      xp: 0,
      xpToNext: xpForLevel(1),
      bonusAtk: 0,
      bonusHp: 0,
      bonusStm: 0,
      bonusSpd: 0,        // percent, not a multiplier - see playerSpeedMult()
      pendingLevels: 0,   // levels banked but not yet spent; the modal reopens per level
      choiceIndex: 0      // which option the keyboard cursor is on
    };

    const LEVEL_CHOICE_KEYS = ['strength', 'stamina', 'survival', 'speed'];
    let levelUpOpen = false;
    // How far the dungeon's bed drops under the level-up loop. Ducked rather than silenced, so
    // the run is still audibly going on underneath the choice.
    const LEVELUP_DUCK = 0.18;
    // Tracks whether the music swap has happened, separately from levelUpOpen: two banked
    // levels re-open the box without ever closing it, and the loop must not restart between
    // them (playScreenMusic is idempotent, but the duck ramp would retrigger).
    let levelUpMusicWasOpen = false;

    // ---- Progression -------------------------------------------------------

    // The bars are derived, never edited in place: max = base + banked bonuses. Anything that
    // changes a bonus (a level-up pick) or clears them (a new dungeon) calls this.
    // The one number every SPEED-governed measurement multiplies by. A function rather than a
    // stored field so there is nothing to keep in sync - a pick changes bonusSpd and every
    // reader picks it up on its next frame.
    function playerSpeedMult() {
      return Math.min(SPEED_MAX_MULT, 1 + progression.bonusSpd / 100);
    }

    function applyProgressionStats() {
      combatState.playerMaxHp = BASE_MAX_HP + progression.bonusHp;
      combatState.playerMaxStm = BASE_MAX_STM + progression.bonusStm;
      combatState.playerHp = Math.min(combatState.playerHp, combatState.playerMaxHp);
      combatState.playerStm = Math.min(combatState.playerStm, combatState.playerMaxStm);
    }

    function updateProgressionHUD() {
      if (playerLevelBadge) playerLevelBadge.textContent = `LV ${progression.level}`;
      if (playerXpBar) {
        playerXpBar.style.width = `${Math.min(100, (progression.xp / progression.xpToNext) * 100)}%`;
      }
      if (playerXpText) playerXpText.textContent = `${progression.xp}/${progression.xpToNext}`;
      if (encounterBadge) {
        const left = enemyMarkers.filter(m => m.alive).length;
        encounterBadge.textContent = left ? `Foes: ${left}` : 'Foes: cleared';
      }
    }

    function resetProgression() {
      progression.level = 1;
      progression.xp = 0;
      progression.xpToNext = xpForLevel(1);
      progression.bonusAtk = 0;
      progression.bonusHp = 0;
      progression.bonusStm = 0;
      progression.bonusSpd = 0;
      progression.pendingLevels = 0;
      progression.choiceIndex = 0;
      closeLevelUpModal();
      applyProgressionStats();
      updateProgressionHUD();
    }

    // Award a kill's XP and bank any levels it crossed. A single boss can span two thresholds,
    // so this loops - and pendingLevels means the modal is shown once PER level rather than
    // silently swallowing the second one.
    function grantXp(amount) {
      if (!amount) return;
      progression.xp += amount;
      while (progression.xp >= progression.xpToNext) {
        progression.xp -= progression.xpToNext;
        progression.level++;
        progression.xpToNext = xpForLevel(progression.level);
        progression.pendingLevels++;
      }
      updateProgressionHUD();
      if (progression.pendingLevels > 0) openLevelUpModal();
    }

    function openLevelUpModal() {
      if (!levelUpModal || progression.pendingLevels <= 0) return;
      levelUpOpen = true;
      releaseHeldKeys();          // a held guard must not drain stamina behind the modal
      progression.choiceIndex = 0;
      if (levelUpLevelText) {
        // The level being SPENT, not necessarily the one just reached - two banked levels are
        // taken one at a time, oldest first.
        const spending = progression.level - progression.pendingLevels + 1;
        levelUpLevelText.textContent = `Level ${spending}`;
      }
      const sTxt = document.getElementById('levelUpStrengthText');
      const tTxt = document.getElementById('levelUpStaminaText');
      const vTxt = document.getElementById('levelUpSurvivalText');
      const pTxt = document.getElementById('levelUpSpeedText');
      if (sTxt) sTxt.textContent = `+${LEVEL_GAINS.strength} attack damage`;
      if (tTxt) tTxt.textContent = `+${LEVEL_GAINS.stamina} max stamina`;
      if (vTxt) vTxt.textContent = `+${LEVEL_GAINS.survival} max health`;
      // Shows the CAPPED result, so a hero already at the ceiling is told the truth rather than
      // sold a ninth +8% that does nothing.
      if (pTxt) {
        const now = playerSpeedMult();
        const next = Math.min(SPEED_MAX_MULT, 1 + (progression.bonusSpd + LEVEL_GAINS.speed) / 100);
        const gain = Math.round((next - now) * 100);
        pTxt.textContent = gain > 0 ? `+${gain}% strafe / swing / regen` : 'speed already maxed';
      }
      levelUpModal.classList.remove('hidden');
      syncLevelUpSelection();
      playSfx('end', { vary: 0, gain: 0.55 });
      // The dungeon's bed steps aside for the level-up loop rather than stopping: this is a
      // pause inside the run, not the end of one, so the explore/battle beds are ducked (and
      // kept running) and brought straight back when the choice is taken. Both calls are
      // no-ops when the loop or the bank never loaded, so a silent run stays silent.
      if (!levelUpMusicWasOpen) {
        levelUpMusicWasOpen = true;
        duckDungeonMusic(LEVELUP_DUCK, 0.35);
        playScreenMusic('levelup');
      }
    }

    function closeLevelUpModal() {
      levelUpOpen = false;
      if (levelUpModal) levelUpModal.classList.add('hidden');
      if (levelUpMusicWasOpen) {
        levelUpMusicWasOpen = false;
        stopScreenMusic(0.5);
        duckDungeonMusic(1, 1.1);
      }
    }

    function syncLevelUpSelection() {
      if (!levelUpChoices) return;
      const btns = levelUpChoices.querySelectorAll('.levelup-choice');
      btns.forEach((b, i) => b.classList.toggle('selected', i === progression.choiceIndex));
    }

    function moveLevelUpSelection(delta) {
      const n = LEVEL_CHOICE_KEYS.length;
      progression.choiceIndex = (progression.choiceIndex + delta + n) % n;
      syncLevelUpSelection();
      playSfx('turn', { gain: 0.4 });
    }

    function applyLevelChoice(kind) {
      if (!levelUpOpen || progression.pendingLevels <= 0) return;
      if (kind === 'strength') progression.bonusAtk += LEVEL_GAINS.strength;
      else if (kind === 'stamina') progression.bonusStm += LEVEL_GAINS.stamina;
      else if (kind === 'survival') progression.bonusHp += LEVEL_GAINS.survival;
      else if (kind === 'speed') progression.bonusSpd += LEVEL_GAINS.speed;
      else return;

      progression.pendingLevels--;
      applyProgressionStats();
      // SURVIVAL's new headroom is handed over filled, and every level tops the hero up - see
      // LEVEL_HEAL_FRAC. Stamina refills the same way so the next fight opens with a full bar.
      const heal = Math.round(combatState.playerMaxHp * LEVEL_HEAL_FRAC)
                 + (kind === 'survival' ? LEVEL_GAINS.survival : 0);
      combatState.playerHp = Math.min(combatState.playerMaxHp, combatState.playerHp + heal);
      combatState.playerStm = combatState.playerMaxStm;
      // A refill that a still-running lock would immediately stamp back to zero is not a refill.
      combatState.exhaustLock = 0;
      combatState.exhaustion = 0;
      updateProgressionHUD();
      playSfx('button', { vary: 0.05 });

      // A second banked level (a boss can carry the hero across two thresholds) is taken as its
      // own pick, straight away. Re-opening in place rather than closing and re-opening on a
      // timer matters: any gap would unfreeze the dungeon between the two choices.
      if (progression.pendingLevels > 0) {
        openLevelUpModal();
      } else {
        closeLevelUpModal();
        render3D();
      }
    }

    if (levelUpChoices) {
      levelUpChoices.querySelectorAll('.levelup-choice').forEach(btn => {
        btn.addEventListener('click', () => applyLevelChoice(btn.dataset.choice));
      });
    }

    // One gate for every input path - the keyboard handler, the D-pad and the combat buttons
    // all check this, so the level-up box really does stop the game rather than just covering it.
    // The victory box locks input the same way: once the player has taken the stairs out, the
    // run is over and the character must not be walked around behind the outro. It stays locked
    // until a full reset (restartDungeon / back to menu) hides the box again.
    // The ending cutscene locks it from the killing blow on: the run is over once it starts.
    function inputLocked() {
      return levelUpOpen || (victoryModal && !victoryModal.classList.contains('hidden'))
        || endingPhase !== 'idle';
    }

    const btnCombatDodgeL = document.getElementById('btnCombatDodgeL');
    const btnCombatAttack = document.getElementById('btnCombatAttack');
    const btnCombatBlock = document.getElementById('btnCombatBlock');
    const btnCombatDodgeR = document.getElementById('btnCombatDodgeR');

    // Strike / Block / Strafe: greyed out and inert except during a live fight. The action bar
    // only hides when toggleBattleMode(false) runs, so it lingers on screen through the death
    // freeze and the win outro - and a corpse must not be able to swing, nor the player keep
    // strafing once the fight is decided. toggleBattleMode(true) switches them back on.
    const combatBtns = [btnCombatAttack, btnCombatBlock, btnCombatDodgeL, btnCombatDodgeR];
    function setCombatButtonsLive(live) {
      for (const b of combatBtns) if (b) b.disabled = !live;
    }

    const keysHeld = {
      left: false,
      right: false,
      block: false
    };


    const combatState = {
      inBattle: false,
      dead: false,              // set by killPlayer(); freezes combat until Rise / new dungeon
      // How many sim ticks the current battle has been running. Drives the entrance: the hero
      // slides up from below the frame while the foe dither-fades in. Both are done, and both
      // fighters unfrozen, at INTRO_TOTAL.
      introFrame: 0,
      pendingXp: 0,             // banked at the kill, paid out when the death fade finishes
      // The hero's own outro, played once every foe is down and dissolved. winTick counts sim
      // steps since it began; winIsLevelUp is latched on the first of those and picks which
      // outro runs - a dithering fade-out on a plain win, or staying on screen to jump for joy
      // when the win banked a level (the level-up box opens when the hop finishes).
      winTick: 0,
      winIsLevelUp: false,
      playerHp: 100,
      playerMaxHp: 100,
      playerStm: 100,
      playerMaxStm: 100,
      playerX: 0,
      vx: 0,
      // Which way the hero is turned: 1 draws the rig as generated, -1 mirrors it. Set off the
      // strafe keys in combatTick, so it holds through the glide to a stop after they let go.
      playerFacing: 1,
      attackFrame: 0,
      maxAttackFrames: 18,
      hurtFrame: 0,
      maxHurtFrames: 24,
      shieldProgress: 0.0,
      combatEffects: [],
      // Every foe on the field. A normal fight holds exactly one entry, and enemies[0] is
      // always the same object as `enemy` below - the lead. The pack variants (swarmer /
      // circler) fill it with 3 / 2 of them. Anything that reads ONE foe (the death epitaph,
      // killPlayer, the name plate) still reads the lead; anything that fights reads the array.
      enemies: [],
      enemy: {
        name: 'NIGHTSTALKER',
        variant: 'walker',
        hp: 100,
        maxHp: 100,
        attackTimer: 110,
        state: 'idle',
        stateTimer: 0,
        x: 0,            // horizontal offset from centre, px
        vx: 0,
        altitude: 0,     // 0 = grounded; >0 = hovering height (flyer)
        swoop: 'none',   // flyer: none | diving | striking | rising
        swoopTimer: 0,
        blockTimer: 0,   // >0 = guarding; a player strike caught on it does no damage
        punishTimer: 0,  // walker: >0 = still recovering from its own attack, can't guard (the opening)
        strikeLanded: false, // this attack's blow has landed: draw the strike frame (Last Attack Frame)
        atkCount: 0,     // boss: swings taken in the current patrol phase (3 -> hunt)
        hunting: false,  // boss: walking the player down instead of drifting left/right
        chargeCount: 0,  // boss: swings thrown since its last charge (5 -> the charge)
        special: 'none', // boss: phase of the charge - none|back|weave|pause|windup|rush
        specialTimer: 0,
        depth: 0,        // 0 = on the front line, where a fight is fought; 1 = back of the arena
        weaveDir: 1,     // boss: which way it is currently sweeping during the charge's weave
        lockX: 0,        // boss: the line the charge is coming down, fixed as the rush starts
        noBlockTimer: 0, // >0 = cannot raise a guard at all (the charge's recovery)
        orbit: 0,        // circler: angle around its holding pattern, radians
        laps: 0,         // circler: full circles flown since its last swoop
        homeX: 0,        // circler: the centre that circle is drawn around
        slotX: 0,        // circler: the centre its pack slot OWNS - homeX returns here after a swoop
        orbitBase: 0,    // circler: the phase its pack slot owns, so a pack re-forms fanned out
        formOffset: 0,   // swarmer: the spot it walks to, px either side of the player
        diveOffset: 0,   // circler: the spot it dives at, px either side of the player
        deathFade: 0     // >0 once killed: ticks up while the corpse dithers away
      },
      faceState: 'idle',
      faceTimer: 0,
      // 0..1, smoothed. How spent the hero looks: 0 while a swing is still affordable, and
      // ramping to 1 as the bar empties past that. Purely cosmetic - what the player can
      // actually DO is still gated on playerStm itself - but it is what makes an out-of-gas
      // hero read as out of gas instead of standing there fresh.
      exhaustion: 0,
      // Sim ticks left on an overexertion lock (see combatAttack). While it runs the bar is
      // pinned at 0 rather than merely draining slowly, which is what makes the 2 seconds a
      // real punishment instead of a rounding error against 0.45/tick regen.
      exhaustLock: 0,
      glanceDir: 0,
      glanceTimer: 60
    };
    // The lead is enemies[0], always - see the comment on the array above.
    combatState.enemies = [combatState.enemy];

    // walker / flyer / boss - one typed enemy idea, three battlefield roles. Stats and AI
    // differ here; the distinct sprites come from the server (bundle.enemy_variants).
    //   heightFrac - target on-screen height as a fraction of the 240px combat canvas.
    //                The boss is pinned near the ceiling: its feet sit at GROUND_Y (165), so
    //                anything above ~0.69 clips off the top of the frame. The size gap is
    //                therefore made by keeping the walker SMALL rather than the boss bigger -
    //                0.44 vs 0.68 is a clear 1.5x, and 106px also matches the ~104px the
    //                original procedural enemy was drawn at.
    //   widthFrac  - hard cap on drawn width as a fraction of the 320px width. Sprites now
    //                fill their generated canvas, so a winged flyer arrives far wider than
    //                it is tall and would otherwise span the whole screen.
    //   bodyR      - half-width of the silhouette in arena px, added to SWING_REACH to decide
    //                whether a player swing connects (see SWING_REACH below). Authored to
    //                match how wide the variant reads on screen rather than measured off the
    //                generated art, which varies too much frame to frame to gate a hit on: a
    //                runt is a small target, a dread is a broad one.
    //   cadence    - frames between attacks   telegraph - wind-up lead frames
    // sfxRate pitches every sound this variant causes (hit_enemy, block, death_enemy) - the
    // same three sprites and stats read as one species at three sizes, so the ear does the
    // rest: the flyer sounds small and quick, the boss sounds huge and slow. 1.0 = walker's
    // own recorded pitch, unchanged.
    // blockStm is what CATCHING one of this variant's blows on the shield costs the player.
    // It is the guard's real price - the per-frame hold drain is small change next to it - so it
    // is authored per foe rather than derived from damage: a runt's bite is an annoyance you can
    // eat all day, a dread swing takes half the bar and two of them break the guard outright.
    // canBlock/blockHold: the two foes that fight on the ground guard, and they have a
    // generated block frame to show for it (server ENEMY_VARIANT_FRAMES). The flyer does not
    // - it stays out of reach instead, which is its whole defence, and it has no block frame.
    // A blow caught on ANY foe's guard now does ZERO damage (it used to chip 25% through).
    //
    // The two ground foes guard in different ways:
    //
    //  - boss: blockOdds is rolled ONCE PER FRAME while idle (not mid-attack, wind-up or
    //    stagger) and only when no guard is already up, so the raw number is far smaller than
    //    the behaviour. 0.030/150 sims to ~74% guard uptime. A landed hit breaks the guard
    //    (blockTimer clears), so its fight is a rhythm of blocked-then-clean swings rather
    //    than a wall - the sim's uptime is an upper bound the player's own hits pull down.
    //
    //  - walker: reactiveBlock. It does not gamble on a random guard at all - it answers the
    //    player's swing, snapping its guard up as the strike travels (see tickEnemyAI). A
    //    caught blow does nothing AND does not break this guard. The ONLY opening is
    //    punishWindow: for that many frames after the walker commits to its own attack it
    //    cannot guard, and any hit landed in that gap connects. A landed hit does NOT close the
    //    window early (punishTimer just keeps counting down) - 60 frames (1s at the fixed
    //    60fps tick) is long enough for two swings back to back if the player's timing is good,
    //    without leaving so much open time that a third or fourth sneaks in too.
    //
    // SWING_REACH: how far to either side of the hero their swing can find a foe. It is the
    // mirror of landEnemyStrike's 44px (what a foe's swing reaches the other way), except the
    // hero is swinging AT a body with width, so the player-strike resolution tests
    // |playerX - e.x| <= SWING_REACH + that variant's bodyR. Before this the strike had NO
    // horizontal test at all - it took the nearest foe that wasn't airborne or withdrawn and
    // landed from any distance down the arena, so a flanking swarmer, a foe the player was
    // strafing out from under, or a swoop aimed a frame behind the player all connected for
    // free. Set so a walker toe-to-toe still lands at ~44 (18 + its bodyR of 26): the face-off
    // is unchanged, the range gimmes are gone.
    const SWING_REACH = 18;
    const ENEMY_VARIANTS = {
      walker: { tag: '',       maxHp: 100, dmg: 16, blockStm: 25, cadence: 115, telegraph: 30, heightFrac: 0.44, widthFrac: 0.52, bodyR: 26, fly: false, canBlock: true,  reactiveBlock: true, punishWindow: 60, blockHold: 60,  slow: false, hover: 0,  sfxRate: 1.00, timid: true },
      flyer:  { tag: 'FLYING ', maxHp: 70,  dmg: 13, blockStm: 20, cadence: 95,  telegraph: 20, heightFrac: 0.40, widthFrac: 0.66, bodyR: 30, fly: true,  canBlock: false, blockOdds: 0,        blockHold: 0,   slow: false, hover: 58, sfxRate: 1.35 },
      boss:   { tag: 'DREAD ',  maxHp: 240, dmg: 30, blockStm: 50, cadence: 160, telegraph: 46, heightFrac: 0.68, widthFrac: 0.78, bodyR: 46, fly: false, canBlock: true,  blockOdds: 0.030,   blockHold: 150, slow: true,  hover: 0,  sfxRate: 0.72, timid: false },

      // --- PACK FOES. Neither one costs a generation: `recolorOf` names the variant whose
      // sprites they borrow and hue/sat is the filter laid over every frame of them (see
      // recolorFrame), so a swarm reads as its own creature drawn in another colour. Their
      // heightFrac/widthFrac are the base variant's x0.7 - the "30% smaller" - and `group` is
      // how many of them spawn at once. `spd` overrides the grounded walk speed.
      //
      //   swarmer  three little walkers, 0.44 -> 0.308 tall. No guard at all (the big one's
      //            block is what makes it a wall; these are meant to be swatted), 38 HP each
      //            against its 100, and they attack constantly - a 70-frame cadence against
      //            the walker's 115, with the three clocks fanned out across one cycle by
      //            initEnemy so the pressure is steady rather than one huge simultaneous hit.
      //            Simulated against a passive player who never moves or guards, all three
      //            in range, that is ~10 HP/s of incoming damage against the lone walker's
      //            ~6 - and each kill takes a third of it away, while the walker's guard (a
      //            swarmer has none) roughly halves what the player deals back to IT. The two
      //            fights end up costing about the same, which is what 38 HP a head and a
      //            6-damage bite are tuned for. They also never break off: `timid` is what
      //            makes the lone walker retreat below 30% HP, and these do not have it.
      //   circler  two small flyers, 0.40 -> 0.28 tall, that hold a circular pattern instead
      //            of the flyer's hover. altitude = hover - sin(orbit) * orbitLift runs
      //            52 +/- 26, so the bottom of every lap sits at 26 - under the 34px reach
      //            cut-off in the player's strike, for roughly a quarter of each circle.
      //            Unlike the flyer, which can only be hit during its own swoop, this one
      //            hands the player a window every lap. After CIRCLER_LAPS circles it breaks
      //            off and dives like a flyer.
      swarmer: { tag: 'RUNT ',      maxHp: 38, dmg: 6, blockStm: 15,  cadence: 70, telegraph: 16, heightFrac: 0.308, widthFrac: 0.364, bodyR: 16, fly: false, canBlock: false, blockOdds: 0, blockHold: 0, slow: false, hover: 0,  sfxRate: 1.30, timid: false, spd: 1.15, recolorOf: 'walker', hue: 205, sat: 1.25, group: 3 },
      circler: { tag: 'FLEDGLING ', maxHp: 48, dmg: 12, blockStm: 10, cadence: 95, telegraph: 20, heightFrac: 0.280, widthFrac: 0.462, bodyR: 22, fly: true,  canBlock: false, blockOdds: 0, blockHold: 0, slow: false, hover: 52, sfxRate: 1.55, timid: false, recolorOf: 'flyer', hue: 125, sat: 1.30, group: 2, orbitRX: 52, orbitLift: 26, orbitSpeed: 0.055 },
    };
    const ENEMY_VARIANT_KEYS = ['walker', 'flyer', 'boss'];
    // Full circles a circler flies before it commits to a swoop.
    const CIRCLER_LAPS = 3;

    // --- THE DREAD CHARGE ------------------------------------------------------------------
    // The boss's set piece, and the only thing in combat that moves in DEPTH. Every
    // BOSS_CHARGE_EVERY swings it stops fighting the fight it has been fighting, walks off the
    // front line entirely (e.depth 0 -> 1, where the player's blade cannot reach it at all - see
    // the reach test in the player-strike resolution), makes a lot of noise, and then comes back
    // down one line at speed. See tickBossCharge for the phases.
    //
    // The three ways it can end are deliberately lopsided, because the whole move is a question
    // about what the player is willing to spend:
    //   eaten    - dmg x BOSS_CHARGE_DMG_MULT. Half a full hero off a 30-damage foe.
    //   guarded  - survivable, and it costs the ENTIRE stamina bar (BOSS_CHARGE_BLOCK_STM is the
    //              hero's max). No swing and no second guard until that regenerates, which
    //              against a foe on a 160-frame cadence is most of the way to its next one.
    //   dodged   - free, and the honest answer. The line is fixed at the PAUSE and never
    //              re-aimed, so reading the pause buys the whole wind-up to walk off it: 62px
    //              of travel (BOSS_CHARGE_REACH - it is a body, not an arm) in ~84 frames,
    //              which the 3.8px/frame strafe covers four times over. The cost is that those
    //              are 84 frames spent walking instead of hitting, and a hero pinned at the
    //              wall on the side it aimed at has nowhere to spend them.
    // And surviving it any of those ways buys BOSS_CHARGE_RECOVER_FRAMES - four seconds where
    // the boss cannot raise its guard AT ALL. Against something that otherwise holds one up
    // ~74% of the time, that window is where the fight is actually won.
    const BOSS_CHARGE_EVERY = 5;            // swings thrown between charges
    const BOSS_BACK_FRAMES = 34;            // withdrawing off the front line
    const BOSS_WEAVE_FRAMES = 100;          // the fast left/right, ~1.7s of it
    const BOSS_PAUSE_FRAMES = 26;           // the dead stop that says the weaving is over
    const BOSS_WINDUP_FRAMES = 40;          // hunkering down and building
    const BOSS_RUSH_FRAMES = 18;            // the run in - 0.3s from the back wall to the blade
    const BOSS_CHARGE_RECOVER_FRAMES = 240; // 4s unable to guard, at the fixed 60fps tick
    const BOSS_WEAVE_SPEED = 6.4;           // px/frame across the back of the arena
    const BOSS_WEAVE_RANGE = 96;            // how far either side of centre the weave sweeps
    const BOSS_CHARGE_DMG_MULT = 1.6;
    const BOSS_CHARGE_REACH = 62;           // vs. a swing's 44 - it is a body, not an arm
    // A timid foe (walker) that has been fleeing this long gives up running and turns to fight
    // instead - see the `flees`/`enraged` handling in tickEnemyAI's grounded branch.
    const FLEE_ENRAGE_FRAMES = 300;         // 5s at the fixed 60fps tick
    const ENRAGE_SPEED_MULT = 2.0;          // vs. the walker's ordinary 0.9 patrol speed
    const ENRAGE_CADENCE_MULT = 0.35;       // shorter gap between swings while enraged
    // FLAT, not a fraction of playerMaxStm. On a base hero that is the entire bar and the guard
    // is a total loss; a hero who has taken STAMINA picks (playerMaxStm is BASE + bonusStm)
    // walks away from the same block with something still in hand. That is the point - it is one
    // of the few places the stat is worth more than the swings it buys.
    const BOSS_CHARGE_BLOCK_STM = 100;
    // How far back a foe has to be before the player's swing stops finding it. The charge spends
    // every phase but the rush above this, so the entire wind-up is unanswerable.
    const REACH_DEPTH = 0.3;
    // Px the horizon pulls a fully withdrawn foe's feet up the canvas, and how much of its size
    // that distance takes. Purely how depth is SOLD - see drawEnemyBody.
    const DEPTH_LIFT = 34;
    const DEPTH_SHRINK = 0.42;
    // Where a grounded foe's feet sit on the 240px combat view. Module scope rather than a
    // local of drawEnemyBody because nearWallStaging measures against it too.
    const GROUND_Y = 165;

    // The enemy name plate's box, and the first y below it a foe is allowed to occupy. Module
    // scope because two unrelated things have to agree on it: drawEnemyHpBar draws the plate
    // here, and drawEnemyBody keeps foes out from behind it. A flyer at full hover put its head
    // exactly where the plate is and the player was left fighting a pair of legs, so anything
    // that would be drawn under the plate is pushed back down to CLEAR instead.
    const HP_PLATE_TOP = 8;
    const HP_PLATE_H = 18;
    const HP_PLATE_CLEAR = HP_PLATE_TOP + HP_PLATE_H + 5;
    // A BOSS fight gets the plate jammed into the very top of the view with a hairline gap
    // under it instead of the inset one. Nothing else changes about the plate - this is purely
    // to hand the boss back the px. It is the only foe big enough to be shrunk by the plate at
    // all (see the fit clamp in drawEnemyBody), so every px the plate gives up is a px of boss,
    // and 8 off the top plus 3 off the gap buys it about 8% more height - enough that it looms
    // again without its face going back under the bar.
    const HP_PLATE_TOP_BOSS = 0;
    const HP_PLATE_CLEAR_BOSS = HP_PLATE_TOP_BOSS + HP_PLATE_H + 2;

    // Is the plate currently a boss's? Asked of the whole side rather than one foe: the plate
    // belongs to the FIGHT (a pack shares one), so the inset it uses has to be the same for
    // every foe drawn under it or a boss and its own name plate would disagree about where the
    // clear line is. In practice the boss always fights alone, so this is just "is that a boss".
    function bossPlate() {
      return combatState.enemies.some(k => k.variant === 'boss')
          || !!(combatState.enemy && combatState.enemy.variant === 'boss');
    }
    function hpPlateTop()   { return bossPlate() ? HP_PLATE_TOP_BOSS   : HP_PLATE_TOP; }
    function hpPlateClear() { return bossPlate() ? HP_PLATE_CLEAR_BOSS : HP_PLATE_CLEAR; }

    // NEAR-WALL PULL-IN. The duel is staged at a fixed spot on the canvas - see GROUND_Y in
    // drawEnemyBody - which quietly assumes there is open floor about a cell and a half ahead.
    // Back the hero into a wall and face it and there isn't: that wall's own floor line drops
    // below the staged feet, so the foe reads as standing partway UP the masonry. These pull it
    // forward instead, down the canvas to just in front of whatever is really there.
    //   CLEARANCE - px the feet clear that floor line by, so the foe is plainly in front of it.
    //   GROUND_MAX - hard floor on the 240px view; below this the foe is more offscreen than on.
    //   SCALE_MAX  - cap on the growth the move implies, so a face-full foe stays a foe.
    //   HEAD_ROOM  - px of canvas kept above the foe, so growing it never decapitates it.
    //   BACK_ROOM  - px above that floor line a fully withdrawn foe stops at, so the boss charge
    //                still has a visible wind-up in a space with no room to wind up in.
    //   EASE       - per-frame approach, so a wall sliding into view grows the foe rather than
    //                snapping it (the raycast distance behind this jumps at corners).
    //   SCALE_DAMP - how much of the growth true perspective asks for the foe actually takes.
    //                Full perspective is technically right and looks wrong: feet at the seam of
    //                a wall you are pressed against means roughly half the staged distance, so
    //                perspective asks for nearly double, and a walker at double reads as a
    //                different, bigger monster rather than the same one standing closer. Playing
    //                it at a third was still too much of both. A tenth is the setting that keeps
    //                the foe recognisably its own size while its feet move down to the seam -
    //                the drop down the canvas does the work of selling the step forward, and
    //                drawing it SMALLER than the new feet line implies is what keeps it reading
    //                as standing off rather than in the hero's face. The BOSS is exempt and
    //                takes the full factor: it is already clamped by HEAD_ROOM long before this
    //                would bite, and looming is its whole character.
    const NEAR_WALL_CLEARANCE = 6;
    const NEAR_WALL_SCALE_DAMP = 0.12;
    const NEAR_WALL_GROUND_MAX = 208;
    const NEAR_WALL_SCALE_MAX = 1.8;
    const NEAR_WALL_HEAD_ROOM = 6;
    const NEAR_WALL_BACK_ROOM = 12;
    const NEAR_WALL_EASE = 0.18;
    // A flyer hovers a fixed height off the floor line, so when the near-wall pull-in walks the
    // whole staging DOWN the canvas the flyer rides down with it and ends up sitting in the
    // hero's face at chest height rather than up out of reach. Lift it back up by this fraction
    // of the pull-in distance, so a flyer pressed against a wall still reads as airborne.
    const NEAR_WALL_FLY_LIFT = 0.4;

    // The hue on swarmer/circler above is only a starting value: every run rolls both of them
    // fresh, and independently - this run's runts can be blue while its fledglings are purple,
    // and the next run's are neither. Rolled inside 60-300 degrees because a rotation near
    // 0/360 is a rotation of nothing, which would draw a pack foe as an undersized copy of the
    // creature it borrows its sprites from. Saturation is left alone; it is tuned per variant
    // to keep the recolour from washing out. recolorFrame caches per (frame, hue|sat), so a
    // new roll simply lands in a new cache slot rather than fighting the old one.
    const PACK_HUE_MIN = 60, PACK_HUE_MAX = 300;
    function rollPackHues() {
      for (const key of ['swarmer', 'circler']) {
        ENEMY_VARIANTS[key].hue = Math.round(PACK_HUE_MIN + Math.random() * (PACK_HUE_MAX - PACK_HUE_MIN));
      }
    }

    // Hue-rotate a generated sprite into a second creature. A canvas filter applies to the
    // whole draw, so one pass into an offscreen canvas the size of the source gives a frame
    // that is a drop-in for the Image everywhere downstream - provided it also answers to
    // naturalWidth / naturalHeight / complete, which solidContentBox and drawEnemyContent both
    // read off it. Cached per (source frame, filter), and deliberately NOT cached while the
    // source is still decoding: a call made before the data URL finished loading hands back
    // the untinted original and retries on the next frame rather than freezing a blank canvas
    // into the cache for the rest of the run.
    const _recolorCache = new WeakMap();
    function recolorFrame(img, hue, sat) {
      if (!img || !img.complete || !(img.naturalWidth > 0)) return img;
      let perImg = _recolorCache.get(img);
      if (!perImg) { perImg = new Map(); _recolorCache.set(img, perImg); }
      const ck = hue + '|' + sat;
      const hit = perImg.get(ck);
      if (hit) return hit;
      const w = img.naturalWidth, h = img.naturalHeight;
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      const cx = cv.getContext('2d');
      // A browser with no canvas-filter support just draws the copy through untinted - the
      // pack still fights at its own size and stats, it simply isn't recoloured.
      cx.filter = `hue-rotate(${hue}deg) saturate(${sat})`;
      cx.drawImage(img, 0, 0, w, h);
      Object.defineProperty(cv, 'naturalWidth', { value: w });
      Object.defineProperty(cv, 'naturalHeight', { value: h });
      Object.defineProperty(cv, 'complete', { value: true });
      perImg.set(ck, cv);
      return cv;
    }

    // A red-washed copy of a frame, for the beaten boss held before the ending cutscene's cut (see
    // endingHold). Same caching and the same image-like canvas as recolorFrame, and the same size
    // as its source, so drawEnemyContent still sizes it off the idle's measured box.
    const _hurtTintCache = new WeakMap();
    function hurtTintFrame(img) {
      if (!img || !img.complete || !(img.naturalWidth > 0)) return img;
      const hit = _hurtTintCache.get(img);
      if (hit) return hit;
      const w = img.naturalWidth, h = img.naturalHeight;
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      const cx = cv.getContext('2d');
      cx.drawImage(img, 0, 0, w, h);
      // source-atop paints only where the sprite already has pixels, so the silhouette keeps its
      // own edges and the transparent surround stays transparent.
      cx.globalCompositeOperation = 'source-atop';
      cx.fillStyle = 'rgba(255, 40, 30, 0.55)';
      cx.fillRect(0, 0, w, h);
      Object.defineProperty(cv, 'naturalWidth', { value: w });
      Object.defineProperty(cv, 'naturalHeight', { value: h });
      Object.defineProperty(cv, 'complete', { value: true });
      _hurtTintCache.set(img, cv);
      return cv;
    }

    // The {idle, attack, block} set a variant draws with. Base variants own theirs; a pack foe
    // borrows its base's and recolours every frame of it. Null means the sprite it needs never
    // arrived, which is the caller's cue to fall back to whatever the mode did ship.
    function enemyFramesFor(key) {
      const cfg = ENEMY_VARIANTS[key];
      if (!cfg) return null;
      if (!cfg.recolorOf) {
        const own = enemyVariantImgs[key];
        return (own && own.idle) ? own : null;
      }
      const base = enemyVariantImgs[cfg.recolorOf];
      if (!base || !base.idle) return null;
      const out = {};
      for (const f of Object.keys(base)) out[f] = recolorFrame(base[f], cfg.hue, cfg.sat);
      return out;
    }

    // What a battle with no marker behind it (Space, in testing) rolls, and the pool
    // placeEnemyMarkers scatters. Kept apart from ENEMY_VARIANT_KEYS, which is the
    // "did the bundle ship distinct sprites" check and has to stay the three generated foes.
    const ENEMY_ROLL_KEYS = ['walker', 'flyer', 'boss', 'swarmer', 'circler'];

    // Roll one of the three foes and apply its stats. Called on every battle entry, so during
    // testing you cycle the variants just by leaving and re-entering combat (Space).
    function pickEnemyVariant(forceKey) {
      // Only roll the full set when we actually have distinct sprites for it (v5/v6 krea);
      // other modes ship one enemy, so they stay on the walker.
      const haveVariants = ENEMY_VARIANT_KEYS.filter(k => enemyVariantImgs[k] &&
                                                          enemyVariantImgs[k].idle).length >= 2;
      // A marker asks for the foe it was drawn as, but a mode that shipped one enemy sprite
      // can only field the walker - fighting a "boss" wearing the walker's art (and its 240 HP)
      // would be a bug, not a surprise.
      let key = haveVariants
        ? (forceKey || ENEMY_ROLL_KEYS[Math.floor(Math.random() * ENEMY_ROLL_KEYS.length)])
        : 'walker';
      // A pack foe exists only as a recolour, so it needs the sprite it borrows. Dropping back
      // to that base variant keeps a marker drawn as a swarm from arriving as three foes with
      // no art, at the cost of it arriving as the one big foe it was recoloured from.
      if (ENEMY_VARIANTS[key] && ENEMY_VARIANTS[key].recolorOf && !enemyFramesFor(key)) {
        key = ENEMY_VARIANTS[key].recolorOf;
      }
      const cfg = ENEMY_VARIANTS[key] || ENEMY_VARIANTS.walker;
      const count = Math.max(1, cfg.group || 1);
      const name = enemyDisplayName(key, cfg);

      // The lead is REUSED, never replaced: killPlayer, deathEpitaph and
      // resetCombatForNewDungeon all hold combatState.enemy directly, so enemies[0] has to
      // stay that same object. The rest of a pack are shallow clones of it.
      const pack = [];
      for (let i = 0; i < count; i++) {
        const e = (i === 0) ? combatState.enemy : Object.assign({}, combatState.enemy);
        initEnemy(e, key, cfg, i, count);
        e.name = name;
        pack.push(e);
      }
      combatState.enemies = pack;

      // Only swap the active sprite when we have a real per-variant set; otherwise leave
      // whatever the bundle loaded (e.g. v3/v4's 3-frame idle/attack/hurt enemy). A pack parks
      // its BASE frames here - the recolour is done per draw by enemyFramesFor, so a sprite
      // that was still decoding at this point still comes out tinted once it lands.
      const set = enemyVariantImgs[cfg.recolorOf || key];
      if (set && set.idle && haveVariants) {
        enemyFrames = set;
        enemySpriteFrames = [set.idle];
      }
      return key;
    }

    // Grunt and flyer are each their own species with its own invented name ("Gravewing
    // Shrike"), so use that when the server sent one - no "FLYING " tag, because a flyer that
    // was designed to fly is not a tagged version of the walker. Without one (older bundle, or
    // the naming call failed) fall back to the tag + the story's common foe name: "THE HORDE",
    // "FLYING THE HORDE".
    // The boss is different: it always fights under the story's own champion name
    // (enemyBossName, e.g. "SALLY THE CASHIER") rather than its species name, because that
    // name is the same one already baked into the intro crawl, the victory outro and the
    // screensaver marquee (see ssStoryMarqueeText) - naming it anything else here would make
    // combat disagree with all three. Species name and tag+style are only a fallback for when
    // the story never produced a boss name.
    // A pack foe never has a generated name of its own - it wears its base variant's name under
    // its own tag, which is exactly what it looks like: "RUNT GRAVEWING SHRIKE".
    function enemyDisplayName(key, cfg) {
      if (cfg.recolorOf) {
        const baseName = (enemyVariantNames && enemyVariantNames[cfg.recolorOf] || '').trim()
          || (enemyStyleName || 'nightstalker');
        return (cfg.tag + baseName).toUpperCase();
      }
      if (key === 'boss') {
        const name = enemyBossName || (enemyVariantNames && enemyVariantNames.boss || '').trim()
          || (cfg.tag + (enemyStyleName || 'nightstalker'));
        return name.toUpperCase();
      }
      const ownName = (enemyVariantNames && enemyVariantNames[key] || '').trim();
      const name = ownName || (cfg.tag + (enemyStyleName || 'nightstalker'));
      return name.toUpperCase();
    }

    // Put one foe on the field. `i` / `count` are its place in the pack, and everything they
    // touch is there to stop a pack behaving as one creature: the attack clocks are fanned out
    // across a full cadence so three swarmers never swing on the same frame, the spawn x is
    // spread across the arena, and each circler starts a lap-fraction round its own circle so
    // two of them are never over the same spot.
    function initEnemy(e, key, cfg, i, count) {
      e.variant = key;
      // Difficulty tax: Medium/Hard mazes field tougher foes (see DIFFICULTIES.enemyHpMul).
      const hpMul = (DIFFICULTIES[selectedDifficulty] || DIFFICULTIES.medium).enemyHpMul || 1;
      e.maxHp = Math.round(cfg.maxHp * hpMul);
      e.hp = e.maxHp;
      e.state = 'idle';
      e.stateTimer = 0;
      e.attackTimer = cfg.cadence + Math.round((cfg.cadence * i) / count);
      e.x = count > 1 ? (i - (count - 1) / 2) * 56 : 0;
      // Boss only - the walker recomputes vx every frame from where the player is standing.
      e.vx = cfg.slow ? 0.5 : 0;
      // Boss attack rhythm - see the grounded-AI block: three patrol swings, then a hunt.
      e.atkCount = 0;
      e.hunting = false;
      // The charge's own clock, which runs across those phases rather than inside one - see
      // tickBossCharge. Depth is reset with it: a fight can only ever start on the front line.
      e.chargeCount = 0;
      e.special = 'none';
      e.specialTimer = 0;
      e.depth = 0;
      e.weaveDir = 1;
      e.lockX = 0;
      e.noBlockTimer = 0;
      e.altitude = cfg.hover;
      e.swoop = 'none';
      e.swoopTimer = cfg.fly ? 90 : 0;
      e.blockTimer = 0;
      e.punishTimer = 0;   // walker: frames left in the opening after its own attack
      e.fleeTimer = 0;     // walker: consecutive frames spent fleeing (see FLEE_ENRAGE_FRAMES)
      e.enraged = false;   // walker: gave up fleeing and is charging the player instead
      e.strikeLanded = false;   // the current attack's blow has landed - see landEnemyStrike
      e.deathFade = 0;
      e.endingHold = false;     // a beaten boss held on screen for the ending cutscene's cut
      // Circler: half a circle apart, around a centre at its own spawn x, so two of them are
      // on opposite sides of their patterns and the player never faces both low points at once.
      // slotX/orbitBase are that arrangement kept as the slot this one OWNS for the whole
      // fight, rather than only the state it happened to start in - a swoop ends by flying
      // back to them (see the 'rising' branch), which is what stops a pack that dived on the
      // same spot from re-forming as one creature.
      e.orbitBase = (Math.PI * 2 * i) / count;
      e.orbit = e.orbitBase;
      e.laps = 0;
      e.homeX = e.x;
      e.slotX = e.x;
      // Where in the pack a swarmer tries to stand, relative to the player. Kept inside the
      // 44px dodge window in landEnemyStrike, so standing still really does let all three
      // connect - stepping aside is what shakes the flankers off. A circler holds the same
      // spread while it dives, but takes its place in the line at the moment it breaks off
      // rather than owning one - see packDiveOffset.
      e.formOffset = count > 1 ? (i - (count - 1) / 2) * 30 : 0;
      e.diveOffset = e.formOffset;
      // Which way the sprite is turned - see updateEnemyFacing. 1 draws the frame as generated,
      // -1 mirrors it. Every fight opens on the generated pose.
      e.facing = 1;
      e.lastX = e.x;
      e.turnTravel = 0;
    }

    // How far a foe has to travel against the way it is facing before it turns round. Taken off
    // the whole tick's movement rather than any one AI branch, because x is driven a dozen ways -
    // a stalk, an orbit, a sway, a lerp onto a charge line - and separatePack shoves neighbours
    // too. The threshold is what keeps that last one from flickering the sprite: two swarmers
    // jostling for the same spot trade sub-pixel nudges in both directions, and any step back
    // the way it is already facing wipes the count, so only a real move in one direction turns it.
    const FACING_TURN_PX = 4;
    function updateEnemyFacing(e) {
      const dx = e.x - e.lastX;
      e.lastX = e.x;
      if (dx === 0) return;
      const dir = dx < 0 ? -1 : 1;
      if (dir === e.facing) { e.turnTravel = 0; return; }
      e.turnTravel += Math.abs(dx);
      if (e.turnTravel >= FACING_TURN_PX) { e.facing = dir; e.turnTravel = 0; }
    }

    // How the entrance plays, in sim ticks. The hero slides up into frame first; the foe
    // starts materialising a few ticks later and takes longer, so it is still resolving out of
    // the dark when the player has landed. Neither side may act until INTRO_TOTAL.
    const INTRO_SLIDE_FRAMES = 26;    // hero's rise from below the frame
    const INTRO_SLIDE_DIST = 170;     // px below the canvas the hero starts at
    const INTRO_FADE_DELAY = 7;       // ticks before the foe begins to appear
    const INTRO_FADE_FRAMES = 34;     // ticks the foe's dither-in takes
    const INTRO_TOTAL = INTRO_FADE_DELAY + INTRO_FADE_FRAMES;
    // How long a corpse takes to dissolve, plus the beat held after it is gone before the
    // dungeon comes back.
    const DEATH_FADE_FRAMES = 40;
    const DEATH_FADE_HOLD = 20;
    // The hero's send-off after a won fight, in sim ticks. A plain win holds a beat, dithers the
    // hero out the same way the corpse went, then holds once more on the empty arena before the
    // dungeon returns. A win that banked a level skips the fade: the hero stays solid and hops
    // for JOY_HOP ticks (see drawOverTheShoulderPlayer), then the level-up box takes the screen.
    const WIN_FADE_DELAY = 8;
    const WIN_FADE_FRAMES = DEATH_FADE_FRAMES;   // dissolve at the same rate the corpse just did
    const WIN_FADE_HOLD = 10;
    const WIN_JOY_HOP_FRAMES = 72;

    function toggleBattleMode(forceState, forceVariant) {
      if (typeof forceState === 'boolean') {
        combatState.inBattle = forceState;
      } else {
        combatState.inBattle = !combatState.inBattle;
      }
      setMusicMode(combatState.inBattle);

      if (combatState.inBattle) {
        if (battleModeBadge) {
          battleModeBadge.textContent = "BATTLE";
          battleModeBadge.className = "text-[9px] font-bold px-1.5 py-0.2 rounded bg-red-600 text-white animate-pulse";
        }
        if (battleActionBar) battleActionBar.classList.remove('hidden');
        setCombatButtonsLive(true);
        // The D-pad's arrows still called moveForward/rotate mid-fight, walking the player
        // around behind the combat view. Swapping it out for the combat buttons settles that
        // and costs no height, since the two grids are the same size.
        if (dpadGrid) dpadGrid.classList.add('hidden');
        if (controlsHeader) controlsHeader.innerHTML = "COMBAT:<br>A/D to move<br>W to strike<br>S to block";

        combatState.playerX = 0;
        combatState.vx = 0;
        combatState.playerFacing = 1;
        combatState.attackFrame = 0;
        combatState.hurtFrame = 0;
        combatState.shieldProgress = 0;
        // Runs the entrance and, until it finishes, freezes both fighters - see combatTick.
        combatState.introFrame = 0;
        combatState.pendingXp = 0;
        combatState.winTick = 0;
        combatState.winIsLevelUp = false;

        // The foe the marker was drawn as; a battle started any other way still rolls at random.
        pickEnemyVariant(forceVariant);

        // Now the foe is known: a boss drags the battle bed down in pitch and tempo, anything
        // else runs it straight (and rides a leftover boss shift back to normal).
        setBattleMusicRate(combatState.enemy.variant === 'boss' ? BOSS_MUSIC_RATE : 1, 1.5);

        const packN = combatState.enemies.length;
        showFloatingCombatText(packN > 1 ? `${combatState.enemy.name} x${packN} APPROACH!`
                                        : `${combatState.enemy.name} APPROACHES!`,
          160, 80, "#facc15");
      } else {
        if (battleModeBadge) {
          battleModeBadge.textContent = "EXPLORATION";
          battleModeBadge.className = "text-[9px] font-bold px-1.5 py-0.2 rounded bg-slate-300 text-slate-800";
        }
        if (battleActionBar) battleActionBar.classList.add('hidden');
        if (dpadGrid) dpadGrid.classList.remove('hidden');
        if (controlsHeader) controlsHeader.textContent = "CONTROLS:";
        combatState.introFrame = 0;
        setBattleMusicRate(1, 0.8);   // fight over - any boss pitch-shift slides back to normal
        // Hiding the action bar mid-press means the Block button never receives its pointerup or
        // pointerleave, so keysHeld.block would stay stuck on - and a stuck block drains stamina to
        // 2 and then blocks its own regen forever (see the regen guard in the combat loop).
        releaseHeldKeys();
      }
      render3D();
    }

    // Fraction of the foe's pixels currently drawn: dithers up over the entrance, holds at 1
    // through the fight, dithers back down as the corpse dissolves. 0 means it is gone.
    function enemyVisibility(which) {
      const e = which || combatState.enemy;
      if (e.deathFade > 0) {
        return Math.max(0, 1 - (e.deathFade - 1) / DEATH_FADE_FRAMES);
      }
      if (combatState.introFrame >= INTRO_TOTAL) return 1;
      return Math.max(0, Math.min(1, (combatState.introFrame - INTRO_FADE_DELAY) / INTRO_FADE_FRAMES));
    }

    // Fraction of the hero's pixels to draw, the mirror of enemyVisibility for the win outro.
    // 1 all through the fight, and 1 through a level-up win (that outro is a hop, not a fade);
    // after a plain win it dithers from 1 to 0 across WIN_FADE_FRAMES and then stays gone.
    function playerWinVisibility() {
      if (combatState.winTick <= 0 || combatState.winIsLevelUp) return 1;
      const t = combatState.winTick - WIN_FADE_DELAY;
      if (t <= 0) return 1;
      return Math.max(0, 1 - t / WIN_FADE_FRAMES);
    }

    // Both fighters are held still until the entrance has played out.
    function battleReady() {
      return combatState.inBattle && combatState.introFrame >= INTRO_TOTAL;
    }

    // Walk onto a marker -> its fight begins. The marker is remembered so the win retires the
    // right one; a loss leaves it standing, so a restarted run has to face it again.
    function startEncounter(marker) {
      if (!marker || !marker.alive) return;
      if (combatState.inBattle || combatState.dead || inputLocked()) return;
      activeMarker = marker;
      queuedAction = null;              // a buffered step must not fire behind the duel
      toggleBattleMode(true, marker.variant);
    }

    function checkEncounterAtPlayer() {
      if (combatState.inBattle || combatState.dead || inputLocked()) return;
      const m = enemyMarkers.find(k => k.alive && k.x === player.gridX && k.y === player.gridY);
      if (m) startEncounter(m);
    }

    // The corpse has finished dissolving: retire the marker, hand the dungeon back, and pay out
    // the XP - which is what may raise the level-up box over the corridor.
    function finishEncounterVictory() {
      const xp = combatState.pendingXp;
      combatState.pendingXp = 0;
      combatState.winTick = 0;
      combatState.winIsLevelUp = false;
      // A won fight hands the hero back to exploration with a full bar. Regen is a flat 27/s
      // everywhere (see the combat loop), so a drained bar would just race itself back to full
      // over the next few corridor steps anyway - snapping it here skips the pointless crawl and
      // opens every encounter fresh. The lock has to lift with it, or the regen guard stamps the
      // refill straight back to zero for its two seconds. Matches the level-up refill. The
      // exhaustion look is cleared with it so the bar stops flashing red the same frame it fills.
      combatState.playerStm = combatState.playerMaxStm;
      combatState.exhaustLock = 0;
      combatState.exhaustion = 0;
      // The boss going down is a story beat the screensaver marquee should reflect even before
      // the player walks the last stretch to the exit - see ssStoryMarqueeText.
      if ((activeMarker && activeMarker.variant === 'boss') ||
          (combatState.enemy && combatState.enemy.variant === 'boss')) {
        bossDefeated = true;
        markRunBeaten();
      }
      if (activeMarker) activeMarker.alive = false;
      activeMarker = null;
      toggleBattleMode(false);
      updateProgressionHUD();
      drawMinimap();
      grantXp(xp);
    }

    // Any held input has to be dropped whenever the player stops actively driving the game, or a
    // key that never got its keyup survives into the next dungeon.
    function releaseHeldKeys() {
      keysHeld.left = false;
      keysHeld.right = false;
      keysHeld.block = false;
    }

    // Twenty ways to say the run ended. {hero} / {area} / {enemy} are filled from the current
    // story and foe when the player goes down - see deathEpitaph().
    const DEATH_MESSAGES = [
      "{hero} fell in {area}, cut down by the {enemy}.",
      "The {enemy} stands over {hero}'s body. {area} claims another.",
      "Here lies {hero}, who thought {area} could be tamed. The {enemy} knew better.",
      "{area} swallowed {hero} whole. The {enemy} barely slowed to feed.",
      "{hero}'s torch went out in {area}. The {enemy} did the rest.",
      "They'll tell stories in {area} about the day the {enemy} broke {hero}.",
      "{hero} came to {area} chasing glory and found the {enemy} instead.",
      "No one will find {hero} in {area}. The {enemy} made sure of that.",
      "The {enemy} had already forgotten {hero}'s name before it left {area}.",
      "{hero} bled out on the cold stone of {area}, the {enemy} already turning away.",
      "{area} has a new decoration: whatever the {enemy} left of {hero}.",
      "{hero} raised a shield. The {enemy} raised the stakes. {area} kept the difference.",
      "Somewhere far from {area}, someone still waits for {hero}. The {enemy} isn't sorry.",
      "The {enemy} has killed better than {hero} in {area}, but not many.",
      "{hero} took one wrong step in {area}. The {enemy} took everything else.",
      "Last line of {hero}'s journal: 'The {area} is quiet. I think the {enemy}—'",
      "The {enemy} of {area} adds {hero} to a very long list.",
      "{hero} died as they lived: underprepared, and in {area}. The {enemy} obliged.",
      "{area} did not mourn {hero}. Neither did the {enemy}.",
      "The {enemy} howled through {area}. {hero} did not answer.",
    ];

    function deathEpitaph() {
      const hero = (dungeonStory && dungeonStory.hero || '').trim() || 'The warrior';
      const area = (dungeonStory && dungeonStory.location || '').trim() || 'this place';
      const enemy = (combatState.enemy && combatState.enemy.name || '').trim() || 'beast';
      const line = DEATH_MESSAGES[Math.floor(Math.random() * DEATH_MESSAGES.length)];
      return line.replace(/\{hero\}/g, hero).replace(/\{area\}/g, area).replace(/\{enemy\}/g, enemy);
    }

    // The outro that closes the run is written AND narrated server-side (_VICTORY_OUTROS in
    // server.py): Piper is handed the finished sentence at generation time so the victory box
    // is read by the same voice that read the crawl. All this end has to do is show the text
    // and, when the story brought a clip, play it. A run with no story at all (the legacy
    // v1-v4 modes) keeps the generic line index.html ships with.
    const VICTORY_TEXT_DEFAULT = victoryText ? victoryText.textContent : '';

    function showVictoryOutro() {
      if (!victoryText) return;
      const outro = (dungeonStory && dungeonStory.outro || '').trim();
      victoryText.textContent = outro || VICTORY_TEXT_DEFAULT;
    }

    // ==========================================
    // VICTORY CONFETTI
    // ==========================================
    // Painted onto #confettiCanvas, the full-bleed sheet behind the win95 victory box.
    // It is a one-shot: three timed drops from above plus two corner poppers firing
    // inward, all under gravity, and the rAF loop retires itself the frame the last
    // scrap leaves the canvas - nothing keeps spinning behind the box or the screensaver.
    // stopConfetti() is the hard cut for leaving the box early (menu / restart).
    const confettiCtx = confettiCanvas ? confettiCanvas.getContext('2d') : null;
    const CONFETTI_COLORS = ['#ef4444', '#f97316', '#facc15', '#22c55e',
                             '#3b82f6', '#a855f7', '#ec4899', '#ffffff'];
    let confettiPieces = [];
    let confettiRaf = 0;
    let confettiLast = 0;
    const confettiTimers = [];

    function sizeConfettiCanvas() {
      if (!confettiCanvas) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = confettiCanvas.clientWidth || confettiCanvas.offsetWidth || 640;
      const h = confettiCanvas.clientHeight || confettiCanvas.offsetHeight || 480;
      confettiCanvas.width = Math.round(w * dpr);
      confettiCanvas.height = Math.round(h * dpr);
      if (confettiCtx) confettiCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    // A drop: `n` scraps seeded across the top edge, drifting down and sideways.
    function confettiDrop(n) {
      const w = confettiCanvas.clientWidth || 640;
      for (let i = 0; i < n; i++) {
        confettiPieces.push({
          x: Math.random() * w,
          y: -20 - Math.random() * 120,
          vx: (Math.random() - 0.5) * 2.4,
          vy: 2 + Math.random() * 3,
          rot: Math.random() * Math.PI,
          vr: (Math.random() - 0.5) * 0.4,
          size: 5 + Math.random() * 6,
          color: CONFETTI_COLORS[(Math.random() * CONFETTI_COLORS.length) | 0],
          round: Math.random() < 0.18,
        });
      }
    }

    // A popper: `n` scraps launched from one bottom corner in a fan aimed up and inward.
    function confettiPopper(fromLeft, n) {
      const w = confettiCanvas.clientWidth || 640;
      const h = confettiCanvas.clientHeight || 480;
      for (let i = 0; i < n; i++) {
        const spread = (Math.random() - 0.5) * 0.7;              // radians off the aim
        // Aim up-and-inward: ~ -53 deg from the left corner, its mirror from the right.
        const aim = (fromLeft ? -Math.PI / 3.4 : -Math.PI + Math.PI / 3.4) + spread;
        const speed = 7 + Math.random() * 7;
        confettiPieces.push({
          x: fromLeft ? -8 : w + 8,
          y: h + 8,
          vx: Math.cos(aim) * speed,
          vy: Math.sin(aim) * speed,
          rot: Math.random() * Math.PI,
          vr: (Math.random() - 0.5) * 0.5,
          size: 5 + Math.random() * 6,
          color: CONFETTI_COLORS[(Math.random() * CONFETTI_COLORS.length) | 0],
          round: Math.random() < 0.18,
        });
      }
    }

    function confettiFrame(now) {
      if (!confettiCtx) return;
      const dt = confettiLast ? Math.min((now - confettiLast) / 16.667, 3) : 1;
      confettiLast = now;
      const w = confettiCanvas.clientWidth || 640;
      const h = confettiCanvas.clientHeight || 480;

      // clearRect runs in the dpr-scaled space set by setTransform, so CSS px are right here.
      confettiCtx.clearRect(0, 0, w, h);
      for (let i = confettiPieces.length - 1; i >= 0; i--) {
        const p = confettiPieces[i];
        p.vy += 0.16 * dt;            // gravity
        p.vx *= Math.pow(0.99, dt);   // air drag
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.rot += p.vr * dt;

        if (p.y > h + 24) { confettiPieces.splice(i, 1); continue; }

        confettiCtx.save();
        confettiCtx.translate(p.x, p.y);
        confettiCtx.rotate(p.rot);
        confettiCtx.fillStyle = p.color;
        if (p.round) {
          confettiCtx.beginPath();
          confettiCtx.arc(0, 0, p.size * 0.5, 0, Math.PI * 2);
          confettiCtx.fill();
        } else {
          confettiCtx.fillRect(-p.size * 0.5, -p.size * 0.35, p.size, p.size * 0.7);
        }
        confettiCtx.restore();
      }

      if (confettiPieces.length > 0) {
        confettiRaf = requestAnimationFrame(confettiFrame);
      } else {
        confettiRaf = 0;
      }
    }

    function startConfetti() {
      if (!confettiCtx) return;
      stopConfetti();
      sizeConfettiCanvas();
      window.addEventListener('resize', sizeConfettiCanvas);

      confettiDrop(90);
      confettiPopper(true, 45);
      confettiPopper(false, 45);
      confettiTimers.push(setTimeout(() => confettiDrop(50), 350));
      confettiTimers.push(setTimeout(() => confettiDrop(40), 800));

      confettiLast = 0;
      if (!confettiRaf) confettiRaf = requestAnimationFrame(confettiFrame);
    }

    function stopConfetti() {
      while (confettiTimers.length) clearTimeout(confettiTimers.pop());
      if (confettiRaf) { cancelAnimationFrame(confettiRaf); confettiRaf = 0; }
      confettiPieces = [];
      window.removeEventListener('resize', sizeConfettiCanvas);
      if (confettiCtx) confettiCtx.clearRect(0, 0, confettiCanvas.width, confettiCanvas.height); // device px - covers all
    }

    // The clip comes in a beat after the box, once the 'end' sting has landed and the victory
    // loop is on its way up, and the loop is ducked for as long as the narrator speaks. Same
    // plain <audio> element the crawl narrator uses - it sits outside the WebAudio graph, so
    // the duck is the only thing balancing the two.
    const OUTRO_NARRATE_DELAY_MS = 1400;
    const OUTRO_MUSIC_DUCK = 0.4;
    let outroAudio = null;
    let outroTimer = null;
    let outroDucked = false;

    // The narrator finished (or never got started). Hands the victory loop its volume back.
    function endOutroNarration() {
      if (!outroDucked) return;
      outroDucked = false;
      duckScreenMusic(1, 0.9);
    }

    // Teardown, not the natural end: the player left the box - restart, or out to the menu -
    // while the narrator was still talking. Both of those routes stop the screen loop
    // outright, so the duck is dropped rather than ramped back onto a node that is going away.
    function stopOutroNarration() {
      if (outroTimer) { clearTimeout(outroTimer); outroTimer = null; }
      if (outroAudio) {
        try { outroAudio.pause(); } catch (e) {}
        outroAudio.removeAttribute('src');
      }
      outroDucked = false;
    }

    function startOutroNarration() {
      const src = (dungeonStory && dungeonStory.outro_audio) || '';
      stopOutroNarration();
      if (!src) return;
      outroTimer = setTimeout(() => {
        outroTimer = null;
        // The box can be gone already - restarting inside the delay is one keypress.
        if (!victoryModal || victoryModal.classList.contains('hidden')) return;
        if (!outroAudio) {
          outroAudio = new Audio();
          outroAudio.addEventListener('ended', endOutroNarration);
          outroAudio.addEventListener('error', endOutroNarration);
        }
        outroDucked = true;
        duckScreenMusic(OUTRO_MUSIC_DUCK, 0.5);
        outroAudio.src = src;
        const p = outroAudio.play();
        // A blocked autoplay gets no retry button here - the run is over and the words are
        // already on screen - but the loop must not stay ducked under a narrator that never
        // spoke.
        if (p && p.catch) p.catch(() => endOutroNarration());
      }, OUTRO_NARRATE_DELAY_MS);
    }

    // The one victory box, raised either by stepping onto the stairs (drawMinimap) or over the
    // ending cutscene's last frame (finishEndingPlayback). `overEnding` lightens the wash so the
    // held frame reads through it. A box coming back up after the player replayed the cutscene
    // from it does not narrate the outro a second time.
    let victoryShownThisRun = false;
    function showVictoryBox(overEnding) {
      if (!victoryModal || !victoryModal.classList.contains('hidden')) return;
      const firstTime = !victoryShownThisRun;
      victoryShownThisRun = true;
      markRunBeaten();
      winMovesCount.textContent = totalMoves;
      victoryModal.classList.toggle('over-ending', !!overEnding);
      paintVictoryFavorite();
      paintVictoryEnding();
      victoryChoiceBtn = btnPlayAgain;   // keyboard cursor starts on "Back to Main Menu"
      syncVictoryChoice();
      showVictoryOutro();
      playSfx('end', { vary: 0 });
      victoryModal.classList.remove('hidden');
      startConfetti();
      if (firstTime) startOutroNarration();
      // Same hand-off as the death box: the dungeon's bed rides out under the 'end' sting
      // and the victory loop scores the box until the player heads back to the menu.
      fadeOutDungeonMusic(0.6);
      // Cancellable: hitting Enter straight through the win box calls stopScreenMusic()
      // (via returnToMenuMusic) before this fires, and the victory loop must not then
      // start up over the menu music the player has already gone back to.
      deferScreenMusic(runVictoryTrack, 700);
    }

    // ==========================================
    // ENDING CUTSCENE (Options > Ending Video)
    // ==========================================
    // server.py films one clip per run with MiniMax H3 - the hero landing the final blow, the
    // boss falling apart with the stairs out glowing at the end of the corridor, the hero cheering
    // - and keeps it beside the saved run as dungeon_sessions/<id>/ending.mp4 (see
    // render_ending_video). This end asks whether the run being played has one, or has one filming
    // in the background; pulls it into memory as a blob the moment it exists; and cuts to it the
    // instant the boss's health runs out. When it ends, the clip's last frame stays up and the
    // victory box rises over it - the same box the stairs raise.
    //
    // A boss that falls before a background render is done gets the ordinary ending: the corpse
    // dissolves, the player walks to the stairs, and the victory box offers the clip ("Watch
    // Ending") once it lands.
    const endingCutscene = document.getElementById('endingCutscene');
    const endingVideoEl = document.getElementById('endingVideo');
    const endingFlash = document.getElementById('endingFlash');
    const endingBadge = document.getElementById('endingBadge');
    const victoryEndingStatus = document.getElementById('victoryEndingStatus');
    const btnVictoryEnding = document.getElementById('btnVictoryEnding');
    const btnVictoryKeepExploring = document.getElementById('btnVictoryKeepExploring');

    // The killing blow's beat before the cut: the damage number and the death cry land and the boss
    // reels in its hurt look for a moment, so the white flash reads as that blow's impact.
    const ENDING_CUT_DELAY_MS = 900;
    // The last frame gets a beat to itself before the victory box rises over it - the clip ends on
    // the hero's victory pose, and it should land before the window does. ESC/Enter cut it short.
    const ENDING_HOLD_MS = 1100;
    const ENDING_POLL_MS = 4000;
    // The <video> plays outside the WebAudio graph, so it gets the music bus's level by hand. H3
    // masters the soundtrack about as hot as the battle bed it was given (measured -14.0 dB mean
    // against the reference's -15.0), and that bed plays through musicMaster at 0.6 - so 0.6 here
    // lands the cutscene's score where the fight's music just was.
    const ENDING_VOLUME = 0.6;
    // H3 stops the soundtrack dead with the picture: the fanfare is at its loudest in the clip's
    // last tenth of a second (measured -12 dB RMS against -14 across the rest), so a clip left to
    // play out ends mid-note. Both players ride its sound down over this last stretch instead - and
    // the cutscene starts the victory loop as the ride begins, so the loop is already up by the
    // last frame and scores the hold under it.
    const ENDING_AUDIO_FADE_SEC = 2.0;

    // Keeps `video`'s volume on the fade for as long as it plays, frame by frame - the <video>
    // sits outside the WebAudio graph, so there is no gain ramp to schedule. `onFadeStart` fires
    // once per play-through, as the fade begins; seeking back to the start re-arms it. A hidden tab
    // gets no animation frames and so no fade, which is why the cutscene's end starts the victory
    // loop again for itself.
    function fadeEndingAudioOut(video, onFadeStart) {
      let raf = 0;
      let fading = false;
      const step = () => {
        raf = 0;
        const left = Number.isFinite(video.duration) ? video.duration - video.currentTime : Infinity;
        const level = Math.max(0, Math.min(1, left / ENDING_AUDIO_FADE_SEC));
        video.volume = ENDING_VOLUME * level;
        if (level >= 1) {
          fading = false;
        } else if (!fading) {
          fading = true;
          if (onFadeStart) onFadeStart();
        }
        if (!video.paused && !video.ended) raf = requestAnimationFrame(step);
      };
      video.addEventListener('play', () => {
        if (!raf) raf = requestAnimationFrame(step);
      });
    }

    // ---- Ending Video Look ---------------------------------------------------------------------
    // H3 films the clip at 512x384 and the viewport blows it up two to three and a half times. Left
    // to the <video>, the browser does that with a soft bilinear stretch. Sharp and Pixel lay a
    // WebGL2 canvas over the video instead and redraw every frame into it at the screen's own device
    // pixels: Sharp through AMD FSR 1 (EASU's edge-aware upscale, then RCAS sharpening), Pixel as
    // plain nearest-neighbour. The <video> underneath still plays, owns the sound and is what every
    // other part of the ending talks to; the canvas only ever shows up once it has drawn a frame of
    // the clip, so until then - and on Smooth, or with no WebGL2 - the video shows through as it
    // always did.
    //
    // RCAS strength in FSR "stops": 0 is its sharpest, each +1 halves it. 0.2 is FSR's own default.
    const ENDING_SHARPNESS = 0.2;

    const CLIP_VERTEX_SHADER = `#version 300 es
layout(location = 0) in vec2 aPos;
void main() { gl_Position = vec4(aPos, 0.0, 1.0); }`;

    // Nearest-neighbour: every screen pixel takes the one clip texel it lands in.
    const CLIP_PIXEL_SHADER = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uOrigin;    // the picture's bottom-left corner on the canvas, in device pixels
uniform vec2 uInSize;    // the clip's size
uniform vec2 uOutSize;   // the picture's size on the canvas
out vec4 outColor;
void main() {
  vec2 p = floor((gl_FragCoord.xy - uOrigin) * (uInSize / uOutSize));
  outColor = vec4(texelFetch(uSrc, ivec2(clamp(p, vec2(0.0), uInSize - 1.0)), 0).rgb, 1.0);
}`;

    // FSR 1 EASU and RCAS, ported from AMD's ffx_fsr1.h (FidelityFX Super Resolution 1.0).
    // Copyright (c) 2021 Advanced Micro Devices, Inc. All rights reserved. MIT license:
    // Permission is hereby granted, free of charge, to any person obtaining a copy of this software
    // and associated documentation files (the "Software"), to deal in the Software without
    // restriction, including without limitation the rights to use, copy, modify, merge, publish,
    // distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the
    // Software is furnished to do so, subject to the following conditions: The above copyright
    // notice and this permission notice shall be included in all copies or substantial portions of
    // the Software. THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
    // IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
    // PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
    // LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
    // OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
    // DEALINGS IN THE SOFTWARE.
    //
    // Differences from the header: texelFetch with clamped coordinates stands in for textureGather,
    // the scale constants are worked out in the shader from the two sizes, and every reciprocal that
    // can meet a zero (flat black, flat white) is guarded - a video's letterbox and fades are exactly
    // that, and a NaN there would come out as a black speck.
    const CLIP_EASU_SHADER = `#version 300 es
precision highp float;
uniform sampler2D uSrc;
uniform vec2 uOrigin;
uniform vec2 uInSize;
uniform vec2 uOutSize;
out vec4 outColor;

vec3 at(vec2 fp, vec2 off) {
  return texelFetch(uSrc, ivec2(clamp(fp + off, vec2(0.0), uInSize - 1.0)), 0).rgb;
}
float luma(vec3 c) { return c.b * 0.5 + (c.r * 0.5 + c.g); }

// One of the four bilinear corners' say in the edge direction and how much of an edge it is.
//    a
//  b c d
//    e
void easuSet(inout vec2 dir, inout float len, float w,
             float lA, float lB, float lC, float lD, float lE) {
  float lenX = max(abs(lD - lC), abs(lC - lB));
  float dirX = lD - lB;
  dir.x += dirX * w;
  lenX = clamp(abs(dirX) / max(lenX, 1e-6), 0.0, 1.0);
  len += lenX * lenX * w;
  float lenY = max(abs(lE - lC), abs(lC - lA));
  float dirY = lE - lA;
  dir.y += dirY * w;
  lenY = clamp(abs(dirY) / max(lenY, 1e-6), 0.0, 1.0);
  len += lenY * lenY * w;
}

// One tap of the rotated, stretched Lanczos-2 approximation.
void easuTap(inout vec3 aC, inout float aW, vec2 off, vec2 dir, vec2 len2,
             float lob, float clp, vec3 c) {
  vec2 v = vec2(off.x * dir.x + off.y * dir.y, off.x * -dir.y + off.y * dir.x) * len2;
  float d2 = min(dot(v, v), clp);
  float wB = 0.4 * d2 - 1.0;
  float wA = lob * d2 - 1.0;
  wB *= wB;
  wA *= wA;
  wB = 1.5625 * wB - 0.5625;
  float w = wB * wA;
  aC += c * w;
  aW += w;
}

void main() {
  vec2 pp = (gl_FragCoord.xy - uOrigin) * (uInSize / uOutSize) - 0.5;
  vec2 fp = floor(pp);
  pp -= fp;
  // 12-tap kernel around f.
  //    b c
  //  e f g h
  //  i j k l
  //    n o
  vec3 b = at(fp, vec2( 0.0, -1.0));
  vec3 c = at(fp, vec2( 1.0, -1.0));
  vec3 e = at(fp, vec2(-1.0,  0.0));
  vec3 f = at(fp, vec2( 0.0,  0.0));
  vec3 g = at(fp, vec2( 1.0,  0.0));
  vec3 h = at(fp, vec2( 2.0,  0.0));
  vec3 i = at(fp, vec2(-1.0,  1.0));
  vec3 j = at(fp, vec2( 0.0,  1.0));
  vec3 k = at(fp, vec2( 1.0,  1.0));
  vec3 l = at(fp, vec2( 2.0,  1.0));
  vec3 n = at(fp, vec2( 0.0,  2.0));
  vec3 o = at(fp, vec2( 1.0,  2.0));
  float bL = luma(b), cL = luma(c), eL = luma(e), fL = luma(f), gL = luma(g), hL = luma(h);
  float iL = luma(i), jL = luma(j), kL = luma(k), lL = luma(l), nL = luma(n), oL = luma(o);

  vec2 dir = vec2(0.0);
  float len = 0.0;
  easuSet(dir, len, (1.0 - pp.x) * (1.0 - pp.y), bL, eL, fL, gL, jL);
  easuSet(dir, len, pp.x * (1.0 - pp.y), cL, fL, gL, hL, kL);
  easuSet(dir, len, (1.0 - pp.x) * pp.y, fL, iL, jL, kL, nL);
  easuSet(dir, len, pp.x * pp.y, gL, jL, kL, lL, oL);

  vec2 dir2 = dir * dir;
  float dirR = dir2.x + dir2.y;
  bool zro = dirR < 1.0 / 32768.0;
  dirR = zro ? 1.0 : inversesqrt(dirR);
  dir.x = zro ? 1.0 : dir.x;
  dir *= dirR;
  len *= 0.5;
  len *= len;
  float stretch = dot(dir, dir) / max(abs(dir.x), abs(dir.y));
  vec2 len2 = vec2(1.0 + (stretch - 1.0) * len, 1.0 - 0.5 * len);
  float lob = 0.5 + ((0.25 - 0.04) - 0.5) * len;
  float clp = 1.0 / lob;

  vec3 min4 = min(min(f, g), min(j, k));
  vec3 max4 = max(max(f, g), max(j, k));
  vec3 aC = vec3(0.0);
  float aW = 0.0;
  easuTap(aC, aW, vec2( 0.0, -1.0) - pp, dir, len2, lob, clp, b);
  easuTap(aC, aW, vec2( 1.0, -1.0) - pp, dir, len2, lob, clp, c);
  easuTap(aC, aW, vec2(-1.0,  1.0) - pp, dir, len2, lob, clp, i);
  easuTap(aC, aW, vec2( 0.0,  1.0) - pp, dir, len2, lob, clp, j);
  easuTap(aC, aW, vec2( 0.0,  0.0) - pp, dir, len2, lob, clp, f);
  easuTap(aC, aW, vec2(-1.0,  0.0) - pp, dir, len2, lob, clp, e);
  easuTap(aC, aW, vec2( 1.0,  1.0) - pp, dir, len2, lob, clp, k);
  easuTap(aC, aW, vec2( 2.0,  1.0) - pp, dir, len2, lob, clp, l);
  easuTap(aC, aW, vec2( 2.0,  0.0) - pp, dir, len2, lob, clp, h);
  easuTap(aC, aW, vec2( 1.0,  0.0) - pp, dir, len2, lob, clp, g);
  easuTap(aC, aW, vec2( 1.0,  2.0) - pp, dir, len2, lob, clp, o);
  easuTap(aC, aW, vec2( 0.0,  2.0) - pp, dir, len2, lob, clp, n);
  // Normalise, then clamp to the four nearest texels so the negative lobes can't ring.
  outColor = vec4(min(max4, max(min4, aC / aW)), 1.0);
}`;

    // RCAS with its noise damping on: the clip is a 1 Mbps h264, and sharpening its block noise
    // at full strength would bring the blocks out along with the detail.
    const CLIP_RCAS_SHADER = `#version 300 es
precision highp float;
uniform sampler2D uSrc;   // EASU's output, exactly uOutSize big
uniform vec2 uOrigin;
uniform vec2 uOutSize;
uniform float uSharp;     // 2^-stops
out vec4 outColor;

vec3 at(ivec2 p) { return texelFetch(uSrc, clamp(p, ivec2(0), ivec2(uOutSize) - 1), 0).rgb; }
float luma(vec3 c) { return c.b * 0.5 + (c.r * 0.5 + c.g); }

void main() {
  //    b
  //  d e f
  //    h
  ivec2 sp = ivec2(gl_FragCoord.xy - uOrigin);
  vec3 b = at(sp + ivec2( 0, -1));
  vec3 d = at(sp + ivec2(-1,  0));
  vec3 e = at(sp);
  vec3 f = at(sp + ivec2( 1,  0));
  vec3 h = at(sp + ivec2( 0,  1));
  float bL = luma(b), dL = luma(d), eL = luma(e), fL = luma(f), hL = luma(h);
  float nz = 0.25 * (bL + dL + fL + hL) - eL;
  float range = max(max(max(bL, dL), max(eL, fL)), hL) - min(min(min(bL, dL), min(eL, fL)), hL);
  nz = clamp(abs(nz) / max(range, 1e-5), 0.0, 1.0);
  nz = -0.5 * nz + 1.0;
  vec3 mn4 = min(min(b, d), min(f, h));
  vec3 mx4 = max(max(b, d), max(f, h));
  vec3 hitMin = min(mn4, e) / max(4.0 * mx4, vec3(1e-5));
  vec3 hitMax = (1.0 - max(mx4, e)) / min(4.0 * mn4 - 4.0, vec3(-1e-5));
  vec3 lobeRGB = max(-hitMin, hitMax);
  float lobe = max(-(0.25 - 1.0 / 16.0), min(max(max(lobeRGB.r, lobeRGB.g), lobeRGB.b), 0.0)) * uSharp;
  lobe *= nz;
  outColor = vec4((lobe * (b + d + f + h) + e) / (4.0 * lobe + 1.0), 1.0);
}`;

    // Puts one movie player under the Ending Video Look and keeps it there; returns its setMode.
    // `canvas` is an .ending-scaler sitting straight over `video`.
    function createClipScaler(video, canvas) {
      const scaler = { setMode: () => {} };
      if (!video || !canvas) return scaler;

      let mode = 'smooth';
      let gl = null;
      let broken = false;       // no WebGL2, a shader that won't build, or a lost context: Smooth for good
      let progs = null;         // { pixel, easu, rcas }
      let srcTex = null;        // the clip's current frame
      let frameCtx = null;      // 2D copy of that frame, which is what gets uploaded (see draw)
      let midTex = null;        // EASU's output, read by RCAS
      let midFbo = null;
      let midW = 0, midH = 0;
      let outW = 0, outH = 0;   // the canvas in device pixels; 0 while the layer is display:none
      let frameCb = 0, rafId = 0;

      const active = () => mode !== 'smooth' && !broken;
      const show = (on) => canvas.classList.toggle('is-off', !on);

      function build(fsSrc) {
        const prog = gl.createProgram();
        [[gl.VERTEX_SHADER, CLIP_VERTEX_SHADER], [gl.FRAGMENT_SHADER, fsSrc]].forEach(([type, src]) => {
          const sh = gl.createShader(type);
          gl.shaderSource(sh, src);
          gl.compileShader(sh);
          if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
          gl.attachShader(prog, sh);
        });
        gl.linkProgram(prog);
        if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
        const u = {};
        ['uSrc', 'uOrigin', 'uInSize', 'uOutSize', 'uSharp'].forEach((name) => {
          u[name] = gl.getUniformLocation(prog, name);
        });
        return { prog, u };
      }

      function makeTexture() {
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        return tex;
      }

      // Built the first time a look other than Smooth is picked. False means stay on Smooth.
      function setup() {
        if (gl) return true;
        if (broken) return false;
        try {
          gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false });
          if (!gl) throw new Error('WebGL2 is not available');
          progs = { pixel: build(CLIP_PIXEL_SHADER), easu: build(CLIP_EASU_SHADER), rcas: build(CLIP_RCAS_SHADER) };
          // One triangle past the corners covers the whole viewport.
          gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
          gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
          gl.enableVertexAttribArray(0);
          gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
          frameCtx = document.createElement('canvas').getContext('2d', { alpha: false });
          if (!frameCtx) throw new Error('no 2D canvas for the frame copy');
          srcTex = makeTexture();
          midTex = makeTexture();
          midFbo = gl.createFramebuffer();
          // Video rows arrive top first; gl_FragCoord counts from the bottom.
          gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
          return true;
        } catch (err) {
          console.warn('Ending Video Look: falling back to Smooth -', err);
          gl = null;
          broken = true;
          return false;
        }
      }

      function drawPass(p, tex, x, y, w, h, inW, inH) {
        gl.viewport(x, y, w, h);
        gl.useProgram(p.prog);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.uniform1i(p.u.uSrc, 0);
        gl.uniform2f(p.u.uOrigin, x, y);
        gl.uniform2f(p.u.uOutSize, w, h);
        if (p.u.uInSize) gl.uniform2f(p.u.uInSize, inW, inH);
        if (p.u.uSharp) gl.uniform1f(p.u.uSharp, Math.pow(2, -ENDING_SHARPNESS));
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }

      // The video's current frame, in the current look, letterboxed the way object-fit: contain
      // would. Quietly does nothing until there is a frame and somewhere to put it.
      function draw() {
        if (!active() || !gl || gl.isContextLost()) return;
        const vw = video.videoWidth;
        const vh = video.videoHeight;
        if (video.readyState < 2 || !vw || !vh || outW < 1 || outH < 1) return;
        try {
          if (canvas.width !== outW) canvas.width = outW;
          if (canvas.height !== outH) canvas.height = outH;
          const s = Math.min(outW / vw, outH / vh);
          const w = Math.max(1, Math.round(vw * s));
          const h = Math.max(1, Math.round(vh * s));
          const x = Math.floor((outW - w) / 2);
          const y = Math.floor((outH - h) / 2);

          // Through a 2D canvas rather than texImage2D(video) straight: Chrome's direct video upload
          // gets the clip's last row of chroma wrong - measured on this clip, the bottom row came up
          // green (71,155,63 where the picture has 127,131,130), flipped or not - and a hard-edged
          // look puts that row right on screen. The 2D copy converts it the way the <video> does.
          const frame = frameCtx.canvas;
          if (frame.width !== vw) frame.width = vw;
          if (frame.height !== vh) frame.height = vh;
          frameCtx.drawImage(video, 0, 0, vw, vh);
          gl.bindTexture(gl.TEXTURE_2D, srcTex);
          gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, frame);

          if (mode === 'sharp') {
            if (midW !== w || midH !== h) {
              gl.bindTexture(gl.TEXTURE_2D, midTex);
              gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
              gl.bindFramebuffer(gl.FRAMEBUFFER, midFbo);
              gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, midTex, 0);
              midW = w;
              midH = h;
            }
            gl.bindFramebuffer(gl.FRAMEBUFFER, midFbo);
            drawPass(progs.easu, srcTex, 0, 0, w, h, vw, vh);
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.viewport(0, 0, outW, outH);
            gl.clearColor(0, 0, 0, 1);
            gl.clear(gl.COLOR_BUFFER_BIT);
            drawPass(progs.rcas, midTex, x, y, w, h, w, h);
          } else {
            gl.bindFramebuffer(gl.FRAMEBUFFER, null);
            gl.viewport(0, 0, outW, outH);
            gl.clearColor(0, 0, 0, 1);
            gl.clear(gl.COLOR_BUFFER_BIT);
            drawPass(progs.pixel, srcTex, x, y, w, h, vw, vh);
          }
          show(true);
        } catch (err) {
          console.warn('Ending Video Look: falling back to Smooth -', err);
          broken = true;
          disarm();
          show(false);
        }
      }

      // One redraw per frame the video actually presents (24 a second, not the display's 60+),
      // re-armed from inside itself. Browsers without requestVideoFrameCallback poll on animation
      // frames while the clip plays.
      function arm() {
        if (!active()) return;
        if (typeof video.requestVideoFrameCallback === 'function') {
          if (!frameCb) {
            frameCb = video.requestVideoFrameCallback(() => { frameCb = 0; draw(); arm(); });
          }
        } else if (!rafId && !video.paused && !video.ended) {
          rafId = requestAnimationFrame(() => { rafId = 0; draw(); arm(); });
        }
      }
      function disarm() {
        if (frameCb && typeof video.cancelVideoFrameCallback === 'function') video.cancelVideoFrameCallback(frameCb);
        frameCb = 0;
        if (rafId) cancelAnimationFrame(rafId);
        rafId = 0;
      }

      scaler.setMode = (look) => {
        mode = look;
        if (active() && !setup()) mode = 'smooth';
        if (active()) {
          arm();
          draw();
        } else {
          disarm();
          show(false);
        }
      };

      // The canvas is backed at exactly its on-screen size in device pixels, so the page's
      // `canvas { image-rendering: pixelated }` has nothing left to scale. Shown again after
      // display:none, it reports its size back and the frame on hold is redrawn at once - a
      // resize (which wipes a canvas) redraws the same way.
      const resized = new ResizeObserver((entries) => {
        const entry = entries[entries.length - 1];
        const box = entry.devicePixelContentBoxSize && entry.devicePixelContentBoxSize[0];
        if (box) {
          outW = box.inlineSize;
          outH = box.blockSize;
        } else {
          const dpr = window.devicePixelRatio || 1;
          outW = Math.round(entry.contentRect.width * dpr);
          outH = Math.round(entry.contentRect.height * dpr);
        }
        draw();
      });
      try { resized.observe(canvas, { box: 'device-pixel-content-box' }); }
      catch (_) { resized.observe(canvas); }

      // A fresh clip or a fresh play takes a fresh frame callback, rather than trusting one that was
      // asked for before the clip loaded.
      const rearm = () => { disarm(); arm(); };
      video.addEventListener('loadeddata', () => { rearm(); draw(); });
      video.addEventListener('seeked', draw);
      video.addEventListener('play', rearm);
      // The clip was unloaded (a run left, the History player closed). The canvas stands down so
      // the next clip never opens on this one's last frame; any pending frame callback went with it.
      video.addEventListener('emptied', () => {
        disarm();
        show(false);
      });
      canvas.addEventListener('webglcontextlost', () => {
        broken = true;
        disarm();
        show(false);
      });

      clipScalers.push(scaler);
      scaler.setMode(endingLook);
      return scaler;
    }

    let endingRunId = null;       // the History id everything below belongs to
    let endingClipUrl = null;      // blob: URL of that run's clip, once fetched
    let endingStatus = null;       // the last /api/ending_video_status reply for that run
    let endingSawFilming = false;  // a background render was seen in progress this run
    let endingPollTimer = null;
    let endingCutTimer = null;
    let endingHoldTimer = null;
    // 'idle' -> 'pending' (the beat after the killing blow) -> 'playing' -> 'held' (ended, last
    // frame up under the victory box). "Watch / Replay Ending" runs held-or-idle -> playing -> held.
    let endingPhase = 'idle';
    let endingPlayed = false;      // the clip has played through at least once this run
    let runBeatenSent = false;     // markRunBeaten has already told the server about this run

    // The boss of the run being played is down - or its victory box is up, which covers a maze
    // where the stairs could be reached around it. Recorded on the server once per run and never
    // cleared: it is what unlocks the run's ending movie in History. The copy in historyEntries is
    // updated too, so a History window opened straight after agrees without a refetch.
    function markRunBeaten() {
      const id = currentRunHistoryId;
      if (!id || runBeatenSent) return;
      runBeatenSent = true;
      if (Array.isArray(historyEntries)) {
        const entry = historyEntries.find(e => e.id === id);
        if (entry) entry.beaten = true;
      }
      if (SHOWCASE_MODE) {
        showcaseState.setBeaten(id);
        return;
      }
      fetch(`${SERVER_URL}/api/history_beaten`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id })
      }).then(res => { if (!res.ok) throw new Error('HTTP ' + res.status); })
        .catch(err => {
          console.warn('Could not record this run as beaten:', err);
          if (id === currentRunHistoryId) runBeatenSent = false;   // the victory box tries again
        });
    }

    // True while the clip covers the viewport - playing, or holding its last frame. The combat
    // sim freezes and the raycaster stops drawing under it.
    function endingOwnsViewport() {
      return endingPhase === 'playing' || endingPhase === 'held';
    }

    function hideEndingLayer() {
      if (endingCutscene) endingCutscene.classList.add('hidden');
      if (endingFlash) endingFlash.classList.remove('is-flashing');
    }

    // Whatever the last run left: its poll, its clip in memory, the layer on screen. Runs as every
    // run starts (prepareEndingCutscene) and whenever one is left.
    function resetEndingCutscene() {
      if (endingPollTimer) { clearTimeout(endingPollTimer); endingPollTimer = null; }
      if (endingCutTimer) { clearTimeout(endingCutTimer); endingCutTimer = null; }
      if (endingHoldTimer) { clearTimeout(endingHoldTimer); endingHoldTimer = null; }
      hideEndingLayer();
      if (endingVideoEl) {
        try { endingVideoEl.pause(); } catch (e) {}
        if (endingVideoEl.getAttribute('src')) {
          endingVideoEl.removeAttribute('src');
          endingVideoEl.load();   // drops the decoded clip rather than keeping it buffered
        }
      }
      if (endingClipUrl) { URL.revokeObjectURL(endingClipUrl); endingClipUrl = null; }
      endingRunId = null;
      endingStatus = null;
      endingSawFilming = false;
      endingPhase = 'idle';
      endingPlayed = false;
      runBeatenSent = false;
      victoryShownThisRun = false;
      if (victoryModal) victoryModal.classList.remove('over-ending');
      paintEndingBadge();
      paintVictoryEnding();
    }

    // A run is starting (enterDungeon): find out whether it has a clip or one on the way. Asks the
    // server to start filming one when the background option is on and it has none - that covers
    // a History replay of a run made without it, and a fresh run whose render the server lost.
    // Where a run's ending clip actually lives: an endpoint on the live server, or the plain file
    // tools/export_showcase.py copied next to that dungeon's bundle.
    function endingClipSrc(id) {
      return SHOWCASE_MODE
        ? `dungeons/${encodeURIComponent(id)}/ending.mp4`
        : `${SERVER_URL}/api/ending_video?id=${encodeURIComponent(id)}`;
    }

    function prepareEndingCutscene() {
      resetEndingCutscene();
      if (!endingVideoOn || !currentRunHistoryId) return;
      endingRunId = currentRunHistoryId;
      // Nothing to poll in the showcase export: no server to film a clip, so this dungeon either
      // shipped with one or never gets one. pollEndingStatus there would 404, land on its
      // 'unknown' branch, and keep re-asking for the rest of the run.
      if (SHOWCASE_MODE) {
        const entry = Array.isArray(historyEntries)
          ? historyEntries.find(e => e.id === endingRunId) : null;
        if (entry && entry.has_ending_video) loadEndingClip(endingRunId);
        return;
      }
      pollEndingStatus(endingRunId, endingBackgroundOn);
    }

    async function pollEndingStatus(id, mayStart) {
      endingPollTimer = null;
      if (id !== endingRunId) return;
      let st = null;
      try {
        const res = await fetch(`${SERVER_URL}/api/ending_video_status?id=${encodeURIComponent(id)}`);
        st = await res.json();
        if (st && st.state === 'none' && mayStart) {
          const started = await fetch(`${SERVER_URL}/api/ending_video_start`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id })
          });
          st = await started.json();
        }
      } catch (err) {
        st = null;   // server away for a moment - keep asking at the normal pace
      }
      if (id !== endingRunId) return;   // the player left this run while the reply was coming
      const state = st ? st.state : 'unknown';
      if (st) endingStatus = st;
      if (state === 'queued' || state === 'rendering') endingSawFilming = true;
      paintEndingBadge();
      paintVictoryEnding();
      if (state === 'ready') { loadEndingClip(id); return; }
      // Still filming, refused for now because a dungeon owns ComfyUI ('busy'), or no answer:
      // look again shortly. none / failed / cancelled / missing are final for this run - a render
      // that failed is not retried in a loop.
      if (['queued', 'rendering', 'busy', 'unknown'].includes(state)) {
        endingPollTimer = setTimeout(() => pollEndingStatus(id, mayStart), ENDING_POLL_MS);
      }
    }

    async function loadEndingClip(id) {
      if (endingClipUrl) return;
      try {
        const res = await fetch(endingClipSrc(id));
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const blob = await res.blob();
        if (id !== endingRunId || endingClipUrl) return;
        endingClipUrl = URL.createObjectURL(blob);
        // Handed to the element now rather than at the boss: preload="auto" decodes it ahead,
        // so the cut lands on a clip that is already sitting in memory.
        if (endingVideoEl) {
          endingVideoEl.src = endingClipUrl;
          endingVideoEl.load();
        }
      } catch (err) {
        console.warn('Ending cutscene could not be loaded:', err);
        // Asked again through the status poll rather than straight back at the file, so a clip
        // that has genuinely gone (its run deleted) settles on "missing" instead of looping here.
        if (!SHOWCASE_MODE && id === endingRunId && !endingPollTimer) {
          endingPollTimer = setTimeout(() => pollEndingStatus(id, false), ENDING_POLL_MS);
        }
      }
      paintEndingBadge();
      paintVictoryEnding();
    }

    // The little status-bar badge for a background render: how far it has got, then READY, so the
    // player can tell whether reaching the boss now plays the cutscene. Only for a render actually
    // seen filming - a clip that was made on the loading screen needs no announcement.
    function paintEndingBadge() {
      if (!endingBadge) return;
      const st = endingStatus ? endingStatus.state : null;
      const show = !!endingRunId && endingSawFilming;
      endingBadge.classList.toggle('hidden', !show);
      if (!show) return;
      if (endingClipUrl) {
        endingBadge.textContent = '🎬 READY';
        endingBadge.title = 'The ending cutscene is ready - it plays when the boss falls.';
      } else if (st === 'rendering' || st === 'queued') {
        endingBadge.textContent = `🎬 ${Math.max(0, Math.min(99, endingStatus.percent || 0))}%`;
        endingBadge.title = 'The ending cutscene is filming in the background. Beat the boss before'
          + ' it finishes and you get the stairs ending instead.';
      } else if (st === 'ready') {
        endingBadge.textContent = '🎬 ...';
        endingBadge.title = 'The ending cutscene is done - loading it.';
      } else {
        endingBadge.textContent = '🎬 ✕';
        endingBadge.title = 'The ending cutscene did not finish'
          + (endingStatus && endingStatus.error ? ': ' + endingStatus.error : '.')
          + ' This run ends at the stairs.';
      }
    }

    // The victory box's cutscene line and button - see the HTML comment on #victoryEndingStatus.
    function paintVictoryEnding() {
      if (!btnVictoryEnding || !victoryEndingStatus) return;
      const hasClip = !!endingClipUrl;
      const st = endingStatus ? endingStatus.state : null;
      const filming = !hasClip && !!endingRunId && ['queued', 'rendering', 'busy', 'ready'].includes(st);
      btnVictoryEnding.classList.toggle('hidden', !hasClip);
      btnVictoryEnding.textContent = endingPlayed ? '🎬 Replay Ending' : '🎬 Watch Ending';
      // Only over the cutscene's last frame, and only while the player is not already standing on
      // the stairs - a box the stairs raised (or a replay watched from one) has nowhere to go back to.
      if (btnVictoryKeepExploring) {
        const onStairs = player.gridX === exitRoom.x && player.gridY === exitRoom.y;
        btnVictoryKeepExploring.classList.toggle('hidden', !(endingPhase === 'held' && !onStairs));
      }
      victoryEndingStatus.classList.toggle('hidden', !filming);
      if (filming) {
        victoryEndingStatus.textContent = st === 'rendering'
          ? `🎬 The ending cutscene is still filming... ${Math.min(99, endingStatus.percent || 0)}%`
          : '🎬 The ending cutscene is on its way...';
      }
      // The button can appear under a box that is already up, so the cursor is re-drawn against
      // whichever buttons are showing now.
      syncVictoryChoice();
    }

    // The boss's health just hit zero. True when a cutscene is taking the ending over.
    function startEndingCutscene() {
      if (!endingVideoOn || !endingClipUrl || endingRunId !== currentRunHistoryId) return false;
      if (endingPhase !== 'idle') return true;
      endingPhase = 'pending';
      releaseHeldKeys();
      setCombatButtonsLive(false);
      // What finishEncounterVictory would have recorded, had the fight been left to finish: the
      // sim freezes under the clip, so it never gets there. The screensaver's story line reads
      // bossDefeated, and the marker is the boss's spot on the map.
      bossDefeated = true;
      markRunBeaten();
      if (activeMarker) activeMarker.alive = false;
      endingCutTimer = setTimeout(() => {
        endingCutTimer = null;
        beginEndingPlayback();
      }, ENDING_CUT_DELAY_MS);
      return true;
    }

    // Cut to the clip - straight out of the boss fight, or from the victory box's button.
    function beginEndingPlayback() {
      if (!endingVideoEl || !endingClipUrl) { finishEndingPlayback(); return; }
      const fromVictoryBox = !!(victoryModal && !victoryModal.classList.contains('hidden'));
      endingPhase = 'playing';
      if (fromVictoryBox) {
        // The box comes down for the clip and everything scoring it goes with it; it rises
        // again over the last frame when the clip ends.
        victoryModal.classList.add('hidden');
        victoryModal.classList.remove('over-ending');
        stopConfetti();
        stopOutroNarration();
        stopScreenMusic(0.4);
      } else {
        // The dungeon's bed rides out under the flash - the clip brings its own score.
        fadeOutDungeonMusic(0.5);
        if (battleModeBadge) {
          battleModeBadge.textContent = 'VICTORY';
          battleModeBadge.className = 'text-[9px] font-bold px-1.5 py-0.2 rounded bg-yellow-400 text-yellow-950';
        }
      }
      if (endingCutscene) endingCutscene.classList.remove('hidden');
      if (endingFlash) {
        endingFlash.classList.remove('is-flashing');
        void endingFlash.offsetWidth;   // restart the animation on a replay
        endingFlash.classList.add('is-flashing');
      }
      endingVideoEl.volume = ENDING_VOLUME;
      endingVideoEl.muted = false;
      try { endingVideoEl.currentTime = 0; } catch (e) { /* not seekable yet - it starts at 0 anyway */ }
      const p = endingVideoEl.play();
      if (p && p.catch) {
        p.catch(() => {
          // Sound refused (no recent gesture to vouch for it): a silent cutscene still beats
          // skipping it. Anything else wrong with the clip goes straight to the victory box.
          if (endingPhase !== 'playing') return;
          endingVideoEl.muted = true;
          endingVideoEl.play().catch(() => finishEndingPlayback());
        });
      }
    }

    // The clip is over - played out, skipped, or unplayable. Its last frame stays on screen (an
    // ended or paused <video> keeps showing the frame it stopped on) and, after a beat, the
    // victory box rises over it.
    function finishEndingPlayback() {
      if (endingPhase !== 'playing' && endingPhase !== 'pending') return;
      endingPhase = 'held';
      endingPlayed = true;
      // Normally already playing, started as the clip's sound began to fade. A skip, or a clip
      // that played out in a hidden tab, never got that far - and the hold must not sit in silence.
      playScreenMusic(runVictoryTrack);
      if (endingHoldTimer) clearTimeout(endingHoldTimer);
      endingHoldTimer = setTimeout(raiseEndingVictoryBox, ENDING_HOLD_MS);
    }

    // The hold is over - or ESC/Enter cut it short.
    function raiseEndingVictoryBox() {
      if (endingHoldTimer) { clearTimeout(endingHoldTimer); endingHoldTimer = null; }
      if (endingPhase === 'held') showVictoryBox(true);
    }

    // True from the clip's end until its victory box is up.
    function endingHolding() {
      return endingPhase === 'held' && !!endingHoldTimer;
    }

    function skipEndingCutscene() {
      if (endingPhase !== 'playing' || !endingVideoEl) return;
      try {
        endingVideoEl.pause();
        // Jump to the final frame, so a skip holds the same still a full watch would.
        if (Number.isFinite(endingVideoEl.duration)) {
          endingVideoEl.currentTime = Math.max(0, endingVideoEl.duration - 0.05);
        }
      } catch (e) { /* the still is whatever frame it stopped on */ }
      finishEndingPlayback();
    }

    function watchEndingFromVictoryBox() {
      if (!endingClipUrl || endingPhase === 'playing' || endingPhase === 'pending') return;
      beginEndingPlayback();
    }

    // "Keep Exploring" on the box over the cutscene's last frame: the boss is down, but the run is
    // not over until the player walks out. The box and the clip step aside, the fight the cut
    // interrupted finishes the ordinary way (the boss leaves the arena, its XP is paid - which can
    // raise the level-up box - and the dungeon comes back), and the stairs raise the victory box
    // again at the end. The clip stays loaded, so that box still offers "Replay Ending".
    function keepExploringAfterEnding() {
      if (endingPhase !== 'held') return;
      if (endingHoldTimer) { clearTimeout(endingHoldTimer); endingHoldTimer = null; }
      victoryModal.classList.add('hidden');
      victoryModal.classList.remove('over-ending');
      stopConfetti();
      stopOutroNarration();
      stopScreenMusic(0.6);
      if (endingVideoEl) { try { endingVideoEl.pause(); } catch (e) {} }
      hideEndingLayer();
      endingPhase = 'idle';
      combatState.enemies.forEach(en => { en.endingHold = false; });
      combatState.winTick = 0;
      combatState.winIsLevelUp = false;
      // The dungeon's beds were faded out and torn down under the flash - bring them back from the
      // top, the way a restart does. finishEncounterVictory below takes the battle flag down first,
      // and the beds only start once they have decoded, so they come up on the exploration track.
      if (dungeonSnapshot && dungeonSnapshot.bundle) loadMusicBank(dungeonSnapshot.bundle.music);
      finishEncounterVictory();
      render3D();
      updateHUD();
    }

    if (endingVideoEl) {
      // The victory loop crossfades in under the clip's fading fanfare. playScreenMusic is
      // idempotent, so showVictoryBox asking for it again when the box rises changes nothing.
      fadeEndingAudioOut(endingVideoEl, () => {
        if (endingPhase === 'playing') playScreenMusic(runVictoryTrack);
      });
      createClipScaler(endingVideoEl, document.getElementById('endingCanvas'));
      endingVideoEl.addEventListener('ended', finishEndingPlayback);
      endingVideoEl.addEventListener('error', () => {
        if (endingPhase === 'playing') finishEndingPlayback();
      });
    }
    if (btnVictoryEnding) btnVictoryEnding.addEventListener('click', watchEndingFromVictoryBox);
    if (btnVictoryKeepExploring) btnVictoryKeepExploring.addEventListener('click', keepExploringAfterEnding);

    // Player defeat. Until this existed playerHp simply floored at 0 in landEnemyStrike and the
    // fight carried on, so there was no moment for a death sound to belong to.
    function killPlayer() {
      if (combatState.dead) return;      // several strikes can resolve on the same frame
      combatState.dead = true;
      playSfx('death_player');
      // Drop the foes back to a neutral pose so the celebration hop isn't frozen mid-swing.
      for (const e of combatState.enemies) {
        e.state = 'idle';
        e.stateTimer = 0;
        e.blockTimer = 0;
      }
      combatState.hurtFrame = 1;
      combatState.faceState = 'hurt';
      combatState.faceTimer = 999;
      releaseHeldKeys();                 // a held block must not survive into the modal
      setCombatButtonsLive(false);       // grey out Strike/Block/Strafe - the fight is lost
      // Swap the pulsing "BATTLE TIME" badge for the verdict. resetCombatForNewDungeon()
      // still runs toggleBattleMode(false) on restart/new-dungeon (inBattle is never cleared
      // here), so this clears itself back to "EXPLORATION TIME" then.
      if (battleModeBadge) {
        battleModeBadge.textContent = "YOU DEAD";
        battleModeBadge.className = "text-[9px] font-bold px-1.5 py-0.2 rounded bg-red-900 text-white";
      }
      if (deadMovesCount) deadMovesCount.textContent = totalMoves;
      if (defeatText) {
        defeatText.textContent = deathEpitaph();
      }
      // The run's own explore/battle bed has no business under a death box; the death loop
      // takes the screen instead and holds until the player restarts (stopScreenMusic) or
      // quits out to the menu (returnToMenuMusic).
      fadeOutDungeonMusic(0.6);
      // A beat before the box, so the death cry and the hurt frame land first.
      setTimeout(() => {
        if (defeatModal) defeatModal.classList.remove('hidden');
        deadChoiceIndex = 0;   // keyboard cursor starts on "Restart Dungeon"
        syncDeadChoice();
      }, 700);
      // Cancellable the same way the victory loop is: a fast restart/quit calls
      // stopScreenMusic() before this fires, and the death loop must not start after it.
      deferScreenMusic('death', 700);
    }

    // Death-screen "Restart Dungeon": roll the whole run back to the instant the player entered
    // - same maze, same gates (re-locked), same spawn - with bars refilled, the step counter
    // zeroed and the dungeon's music restarted from the top. No regeneration, so it's instant.
    // Falls back to the setup screen if there's somehow no snapshot to restore.
    function restartDungeon() {
      if (!dungeonSnapshot) { openSetupScreen(); return; }

      if (defeatModal) defeatModal.classList.add('hidden');
      if (victoryModal) victoryModal.classList.add('hidden');
      stopOutroNarration();
      stopConfetti();
      // A player who kept exploring after the ending cutscene and then died is rolled back to a
      // boss that is standing again - so its next defeat plays the cutscene and narrates the
      // outro fresh, as the first one did. The clip itself stays loaded.
      victoryShownThisRun = false;
      endingPlayed = false;

      // Maze back to its start-of-run shape: closed doors (MAP 3), un-thrown switches (MAP 4),
      // and the walkable-tile list without any tiles a since-opened door had added.
      MAP = dungeonSnapshot.map.map(row => row.slice());
      passagesList = dungeonSnapshot.passages.map(p => ({ x: p.x, y: p.y }));
      doorList = dungeonSnapshot.doors.map(d => ({ ...d }));
      switchList = dungeonSnapshot.switches.map(s => ({ ...s }));
      // Every foe back on its tile, alive again - the same maze means the same fights, and a
      // restart that kept the cleared markers would hand the player a walk to the exit.
      enemyMarkers = (dungeonSnapshot.enemies || []).map(m => ({ ...m }));

      // Spawn pose (same object - other code closes over `player`).
      Object.assign(player, dungeonSnapshot.player);
      player.isAnimating = false;

      // Exploration progress.
      visitedTiles.clear();
      visitedTiles.add(`${player.gridX},${player.gridY}`);
      totalMoves = 0;
      queuedAction = null;
      if (mapProgressBadge) {
        mapProgressBadge.textContent = `${visitedTiles.size}/${passagesList.length} Tiles`;
      }

      // Combat: the same full reset a brand new dungeon gets - full HP/stamina, fresh foe roll,
      // battle chrome cleared, held keys released, `dead` flag lifted.
      resetCombatForNewDungeon();

      // Music from the top: the death loop that was scoring the box gives way, and
      // loadMusicBank tears down the running explore/battle loops and starts them fresh.
      // playSfx('start') is the same sting enterDungeon plays on entry.
      stopScreenMusic();
      loadMusicBank(dungeonSnapshot.bundle && dungeonSnapshot.bundle.music);
      playSfx('start', { vary: 0, gain: START_STING_GAIN });

      render3D();
      drawMinimap();
      updateHUD();
    }

    if (btnRestartDungeon) btnRestartDungeon.addEventListener('click', restartDungeon);
    if (btnDeadMainMenu) btnDeadMainMenu.addEventListener('click', openSetupScreen);

    // Death-box keyboard cursor: which of the two buttons Enter/Space will take.
    // 0 = Restart Dungeon, 1 = Back to Main Menu. killPlayer() resets it to 0 each death.
    const deadChoiceBtns = [btnRestartDungeon, btnDeadMainMenu];
    let deadChoiceIndex = 0;
    function syncDeadChoice() {
      deadChoiceBtns.forEach((b, i) => { if (b) b.classList.toggle('selected', i === deadChoiceIndex); });
    }
    function moveDeadSelection(delta) {
      const n = deadChoiceBtns.length;
      deadChoiceIndex = (deadChoiceIndex + delta + n) % n;
      syncDeadChoice();
      playSfx('turn', { gain: 0.4 });
    }
    function takeDeadChoice() {
      (deadChoiceIndex === 0 ? restartDungeon : openSetupScreen)();
    }

    // Victory-box keyboard cursor: same shape as the death box's above, but starts on "Back to
    // Main Menu" rather than the first button - that button is what Enter/Space always did here
    // before Favorite existed, and defaulting to it keeps that muscle memory working. Held as the
    // button itself rather than an index, because "Watch / Replay Ending" comes and goes at the
    // top of the list (see paintVictoryEnding) and an index would slide onto a different button.
    let victoryChoiceBtn = btnPlayAgain;
    function victoryChoiceBtns() {
      return [btnVictoryEnding, btnVictoryKeepExploring, btnVictoryFavorite, btnPlayAgain]
        .filter(b => b && !b.classList.contains('hidden'));
    }
    function syncVictoryChoice() {
      const btns = victoryChoiceBtns();
      if (!btns.includes(victoryChoiceBtn)) victoryChoiceBtn = btnPlayAgain;
      btns.forEach(b => b.classList.toggle('selected', b === victoryChoiceBtn));
      [btnVictoryEnding, btnVictoryKeepExploring].forEach(b => {
        if (b && !btns.includes(b)) b.classList.remove('selected');
      });
    }
    function moveVictorySelection(delta) {
      const btns = victoryChoiceBtns();
      const n = btns.length;
      if (!n) return;
      const at = Math.max(0, btns.indexOf(victoryChoiceBtn));
      victoryChoiceBtn = btns[(at + delta + n) % n];
      syncVictoryChoice();
      playSfx('turn', { gain: 0.4 });
    }
    function takeVictoryChoice() {
      if (victoryChoiceBtn === btnVictoryEnding) watchEndingFromVictoryBox();
      else if (victoryChoiceBtn === btnVictoryKeepExploring) keepExploringAfterEnding();
      else if (victoryChoiceBtn === btnVictoryFavorite) toggleVictoryFavorite();
      else openSetupScreen();
    }

    // Full combat reset for a brand new dungeon. Without this, stamina (and HP, and any in-flight
    // attack/hurt frames) carried over from the previous dungeon - so a run started while blocking
    // or mid-fight began the next dungeon at near-zero stamina.
    function resetCombatForNewDungeon() {
      // Go through toggleBattleMode rather than just clearing the flag, so the badge, action bar,
      // controls header and Battle/Flee button all return to exploration state too - otherwise the
      // new dungeon starts out of battle but still wearing the "BATTLE TIME" chrome.
      if (combatState.inBattle) toggleBattleMode(false);
      releaseHeldKeys();
      // Levels are a per-run thing: a new dungeon (and a restart, which rolls the run back to
      // its first step) starts the hero at level 1 with the base bars. This has to land BEFORE
      // the refill below, since it is what puts playerMaxHp back to BASE_MAX_HP.
      resetProgression();
      activeMarker = null;
      bossDefeated = false;   // a fresh/rolled-back run has the boss standing again
      combatState.introFrame = 0;
      combatState.pendingXp = 0;
      combatState.winTick = 0;
      combatState.winIsLevelUp = false;
      combatState.enemies.forEach(e => { e.deathFade = 0; });
      combatState.playerStm = combatState.playerMaxStm;
      combatState.playerHp = combatState.playerMaxHp;
      combatState.playerX = 0;
      combatState.vx = 0;
      combatState.playerFacing = 1;
      combatState.attackFrame = 0;
      combatState.hurtFrame = 0;
      combatState.faceState = 'idle';   // else a death-frame face lingers ~16s into the next run
      combatState.faceTimer = 0;
      combatState.shieldProgress = 0;
      combatState.exhaustion = 0;
      combatState.exhaustLock = 0;
      combatState.combatEffects.length = 0;
      combatState.dead = false;
      if (defeatModal) defeatModal.classList.add('hidden');
      setCombatButtonsLive(true);
      pickEnemyVariant();
    }

    // Alt-tabbing or clicking into a text field while holding X swallows the keyup the same way.
    window.addEventListener('blur', releaseHeldKeys);

    function showFloatingCombatText(text, x, y, color = '#ffffff') {
      combatState.combatEffects.push({
        text: text,
        x: x,
        y: y,
        color: color,
        life: 32,
        maxLife: 32
      });
    }

    function combatAttack() {
      if (combatState.dead || inputLocked()) return;
      // No free swing at a foe that hasn't finished arriving, and none at a corpse.
      if (!battleReady() || !combatState.enemies.some(e => e.hp > 0)) return;
      if (combatState.attackFrame > 0 || combatState.hurtFrame > 0) return;
      // An empty bar is an empty bar - nothing comes out of it. This has to sit ABOVE the
      // overexertion branch below, or a player mashing attack through the lock would keep
      // re-arming it and the 2 seconds would never actually run out.
      if (combatState.playerStm <= 0) {
        showFloatingCombatText("EXHAUSTED!", 160, 180, "#ef4444");
        return;
      }
      if (combatState.playerStm < ATTACK_STM_COST) {
        // Overexertion: the swing lands, at full strength, but it takes everything left AND
        // holds the bar at zero for EXHAUST_LOCK_FRAMES - two seconds with no guard, no second
        // swing and a staggering strafe. Trading the next two seconds for one hit now is a
        // real choice against a foe on its last sliver of HP, and a bad one against a fresh
        // boss, which is the whole point of allowing it rather than refusing it.
        combatState.playerStm = 0;
        combatState.exhaustLock = EXHAUST_LOCK_FRAMES;
        showFloatingCombatText("OVEREXERTED!", 160, 180, "#f97316");
      } else {
        combatState.playerStm = Math.max(0, combatState.playerStm - ATTACK_STM_COST);
      }
      // The swing, on the windup. The impact sound is separate, on frame 7 where the hit
      // actually resolves.
      playSfx('attack');
      combatState.attackFrame = 1;
      combatState.faceState = 'attack';
      combatState.faceTimer = 18;
    }

    if (btnCombatDodgeL) {
      btnCombatDodgeL.addEventListener('pointerdown', (e) => { e.preventDefault(); keysHeld.left = true; });
      btnCombatDodgeL.addEventListener('pointerup', () => { keysHeld.left = false; });
      btnCombatDodgeL.addEventListener('pointerleave', () => { keysHeld.left = false; });
    }
    if (btnCombatDodgeR) {
      btnCombatDodgeR.addEventListener('pointerdown', (e) => { e.preventDefault(); keysHeld.right = true; });
      btnCombatDodgeR.addEventListener('pointerup', () => { keysHeld.right = false; });
      btnCombatDodgeR.addEventListener('pointerleave', () => { keysHeld.right = false; });
    }
    if (btnCombatBlock) {
      btnCombatBlock.addEventListener('pointerdown', (e) => { e.preventDefault(); keysHeld.block = true; });
      btnCombatBlock.addEventListener('pointerup', () => { keysHeld.block = false; });
      btnCombatBlock.addEventListener('pointerleave', () => { keysHeld.block = false; });
    }
    if (btnCombatAttack) {
      btnCombatAttack.addEventListener('pointerdown', (e) => { e.preventDefault(); combatAttack(); });
    }

    // Combat runs on a FIXED timestep, decoupled from how often we actually draw.
    //
    // Every counter below (attackTimer, cadence, telegraph, swoopTimer, attackFrame...) is
    // measured in 1/60s frames and stepped exactly once per combatTick(). That was fine while
    // a 60fps timer drove it, but render3D() is a synchronous software raycaster running in the
    // same callback - the moment it blows the 16.7ms budget the browser coalesces the timer,
    // fewer ticks fire, and every attack window stretches out in real seconds. Which is exactly
    // the "enemies get slower when the FPS drops" bug.
    //
    // So: measure real elapsed milliseconds, bank them, and spend them in whole SIM_STEP chunks.
    // A frame that took 33ms runs two ticks, a frame that took 16ms runs one. The sim holds 60
    // steps per real second regardless of frame rate, and none of the tuning numbers had to move.
    // Whole steps matter - the hit resolution checks `attackFrame === 7` and the wind-up checks
    // `attackTimer === cfg.telegraph`, so counters must never skip a value the way `* delta`
    // scaling would make them.
    const SIM_STEP = 1000 / 60;
    const MAX_SIM_STEPS = 5;
    let simLastTime = performance.now();
    let simAccumulator = 0;

    // Resolve one of an enemy's telegraphed strikes against the player's position and guard.
    // Lifted out of the AI so every foe on the field shares one definition of what a landed
    // blow costs. The popups are nudged towards the striker's own x, so three swarmers landing
    // inside the same second don't stack their text on one spot.
    // opts.blockStm overrides what CATCHING this particular blow costs, for strikes whose price
    // on the shield is a property of the move rather than of the creature throwing it - the
    // boss's charge is the only one so far, and it takes the whole bar.
    function landEnemyStrike(e, dmg, dodgeMsg, blockMsg, hitLabel, opts) {
      // This tick is the blow, whatever it turns out to do to the player. Last Attack Frame
      // reads it in drawEnemyBody: 'on' swaps the foe from its attack frame (the wind-up) to its
      // strike frame from here to the end of the attack, 'quick' holds the attack frame back
      // until here, and 'flip' mirrors the foe from here to the end of the attack. Cleared by
      // tickEnemyAI as soon as the foe leaves the attack state.
      e.strikeLanded = true;
      const tx = 160 + (e.x || 0) * 0.4;
      // 44px is a swing's reach. opts.reach widens it for a move that is not a swing - the
      // boss's charge is its whole body coming down a line, so getting clear of it means
      // actually getting clear rather than shuffling to the edge of arm's length.
      const isDodged = Math.abs(combatState.playerX - e.x) > ((opts && opts.reach) || 44);
      const isGuarded = combatState.shieldProgress > 0.6;
      if (isDodged) {
        playSfx('miss_player');
        showFloatingCombatText(dodgeMsg, tx, 130, "#38bdf8");
      } else if (isGuarded) {
        playSfx('block');
        showFloatingCombatText(blockMsg, tx, 140, "#a855f7");
        combatState.playerHp = Math.max(1, combatState.playerHp - Math.round(dmg * 0.12));
        // Absorbing a blow on the shield barely dents HP but takes a bite of stamina - block
        // too many hits without spacing out and the guard breaks. The size of that bite is the
        // variant's own blockStm (runt 15, fledgling 10, flyer 20, walker 25, dread 50), so
        // how tiring a foe is to turtle against is authored per creature rather than falling
        // out of its damage number.
        const cfg = ENEMY_VARIANTS[e.variant] || ENEMY_VARIANTS.walker;
        const stmCost = (opts && opts.blockStm != null) ? opts.blockStm : (cfg.blockStm || 25);
        combatState.playerStm = Math.max(0, combatState.playerStm - stmCost);
        // A move that prices its own guard is priced loudly. The ordinary per-variant bite is
        // felt on the bar and doesn't need saying; losing the whole thing to one blow does.
        if (opts && opts.blockStm != null) {
          showFloatingCombatText(`-${stmCost} STAMINA!`, tx, 152, "#f97316");
        }
      } else {
        combatState.playerHp = Math.max(0, combatState.playerHp - dmg);
        combatState.hurtFrame = 1;
        combatState.faceState = 'hurt';
        combatState.faceTimer = 26;
        showFloatingCombatText(`-${dmg} ${hitLabel}`, tx, 160, "#dc2626");
        // The guarded branch above floors HP at 1, so this is the only path to 0.
        if (combatState.playerHp <= 0) killPlayer();
        else playSfx('hit_player');
      }
    }

    // Keep pack members off one another. Three swarmers all steering at the same player would
    // otherwise stack into one silhouette with one hitbox. Half the overlap comes out of each
    // side, so a pushed-apart pair stays centred where it was rather than one shoving the other
    // across the arena, and the result is clamped a little wider than the ±85 patrol range so
    // the outside of a squeezed pack can still be reached.
    const MIN_PACK_GAP = 30;
    // Where in the line abreast a diving flier aims, relative to the player. It is decided off
    // the order the pack is CURRENTLY flying in rather than off its slot number, because the
    // two circles overlap: the one that spawned on the left is regularly the one on the right
    // by the time it breaks off, and aiming by slot would send the pair swapping sides through
    // each other over the player's head. Leftmost takes the leftmost slot and nobody crosses.
    // The spread is kept inside landEnemyStrike's 44px reach, so a player who stands still
    // still eats every one of them.
    function packDiveOffset(e) {
      const living = combatState.enemies.filter(o => o.hp > 0);
      if (living.length < 2) return 0;
      living.sort((a, b) => a.x - b.x);
      return (living.indexOf(e) - (living.length - 1) / 2) * 30;
    }

    function separatePack(e) {
      for (const o of combatState.enemies) {
        if (o === e || o.hp <= 0) continue;
        const d = e.x - o.x;
        const overlap = MIN_PACK_GAP - Math.abs(d);
        if (overlap <= 0) continue;
        const dir = d === 0 ? (Math.random() < 0.5 ? -1 : 1) : (d < 0 ? -1 : 1);
        e.x = Math.max(-92, Math.min(92, e.x + dir * overlap * 0.5));
        o.x = Math.max(-92, Math.min(92, o.x - dir * overlap * 0.5));
      }
    }

    // The boss's charge, one tick of it. Runs INSTEAD of the ordinary grounded AI for as long as
    // e.special is set - no patrol, no hunt, no cadence clock, no guard - and hands control back
    // by clearing it. The phases, and what each one is for:
    //
    //   back    it withdraws off the front line, shrinking into the arena as it goes. Nothing
    //           the player does can touch it from here (see REACH_DEPTH).
    //   weave   fast sweeps across the back wall. This is the noise: it says a charge is coming
    //           without saying where, so the weave is watched rather than acted on.
    //   pause   a dead stop, and the moment it AIMS: lockX is taken here, off wherever the
    //           player is standing, and is never taken again. This is the frame the player is
    //           meant to start moving on - everything after it is committed to one line.
    //   windup  it hunkers, builds, and slides onto that line, which is what shows the player
    //           where the line is. Still out of reach.
    //   rush    it comes down the line. Depth is spent across the run rather than dropped at
    //           the end, so it crosses back into the player's reach part-way in and a hit can
    //           be traded into it on the way past.
    //
    // See the constants block by CIRCLER_LAPS for what it costs to eat, guard or dodge.
    function tickBossCharge(e, cfg) {
      e.specialTimer--;
      const spd = cfg.spd || 0.5;
      if (e.special === 'back') {
        // The swing that started all this is still landing, so this phase leaves e.state alone
        // and ticks it out itself - the boss backs away mid-follow-through rather than snapping
        // to idle on the frame it turns. A hit taken on the way out settles the same way.
        e.depth = Math.min(1, e.depth + 1 / BOSS_BACK_FRAMES);
        e.x += (0 - e.x) * 0.08;   // drift towards the middle, so the weave has room either side
        if ((e.state === 'attack' || e.state === 'hurt') && --e.stateTimer <= 0) e.state = 'idle';
        if (e.specialTimer <= 0) {
          e.special = 'weave';
          e.specialTimer = BOSS_WEAVE_FRAMES;
          // Open away from the player, so the first sweep crosses the arena rather than
          // starting on top of them.
          e.weaveDir = combatState.playerX < 0 ? 1 : -1;
        }
      } else if (e.special === 'weave') {
        e.depth = 1;
        e.state = 'idle';
        e.x += e.weaveDir * BOSS_WEAVE_SPEED;
        if (e.x > BOSS_WEAVE_RANGE) { e.x = BOSS_WEAVE_RANGE; e.weaveDir = -1; }
        else if (e.x < -BOSS_WEAVE_RANGE) { e.x = -BOSS_WEAVE_RANGE; e.weaveDir = 1; }
        if (e.specialTimer <= 0) { e.special = 'pause'; e.specialTimer = BOSS_PAUSE_FRAMES; }
      } else if (e.special === 'pause') {
        e.state = 'idle';
        // The aim, taken on the first frame of the stop and never taken again. Everything after
        // this - the wind-up drift, the run-in - is committed to this line, which is what makes
        // the pause worth reading: the player has this phase plus the whole wind-up, some 84
        // frames, to walk off it. A charge that re-aimed later would make the telegraph a lie
        // and leave the twitch during the rush as the only real answer.
        if (e.specialTimer === BOSS_PAUSE_FRAMES - 1) {
          e.lockX = combatState.playerX;
          showFloatingCombatText("⚠️ IT TAKES AIM!", 160, 52, "#fbbf24");
        }
        if (e.specialTimer <= 0) {
          e.special = 'windup';
          e.specialTimer = BOSS_WINDUP_FRAMES;
          e.state = 'telegraph';
          // Pitched well under even the boss's own low sfxRate - this is the biggest thing it
          // does, and it should sound like it comes from further away than the rest of the fight.
          playSfx('attack', { rate: cfg.sfxRate * 0.65 });
          showFloatingCombatText("⚠️ IT CHARGES!", 160, 62, "#f87171");
        }
      } else if (e.special === 'windup') {
        e.state = 'telegraph';
        // Settling onto the line it just took - lockX, NOT wherever the player has since moved
        // to. This is the phase that shows the player which line it is, by lining up on it.
        e.x += (e.lockX - e.x) * 0.09;
        if (e.specialTimer <= 0) { e.special = 'rush'; e.specialTimer = BOSS_RUSH_FRAMES; }
      } else if (e.special === 'rush') {
        e.state = 'attack';
        e.depth = Math.max(0, e.depth - 1 / BOSS_RUSH_FRAMES);
        e.x += (e.lockX - e.x) * 0.35;
        if (e.specialTimer <= 0) {
          // Arrival. Snapped onto the line it committed to so the 44px dodge window in
          // landEnemyStrike is measured against the line the player was given, not against
          // wherever the lerp happened to have got to.
          e.depth = 0;
          e.x = e.lockX;
          landEnemyStrike(e, Math.round(cfg.dmg * BOSS_CHARGE_DMG_MULT),
            "SIDESTEPPED THE CHARGE!", "🛡️ CHARGE BLOCKED!", "CHARGE!",
            { blockStm: BOSS_CHARGE_BLOCK_STM, reach: BOSS_CHARGE_REACH });
          // Spent, and everything resets to a fresh patrol: the hunt rhythm, the count towards
          // the next charge, and a full cadence before it swings again. The four seconds with
          // no guard is what the player was buying by living through it.
          e.special = 'none';
          e.stateTimer = 26;
          e.noBlockTimer = BOSS_CHARGE_RECOVER_FRAMES;
          e.blockTimer = 0;
          e.atkCount = 0;
          e.attackTimer = cfg.cadence;
          e.vx = (Math.random() < 0.5 ? -spd : spd);
          // It comes OUT of the charge hunting, for two reasons. It reads right - having just
          // run the player down it keeps coming rather than wandering off - and it is what
          // stops the arrival from teleporting: the charge is aimed at the player's real x,
          // which can be the ±85 strafe limit, while the patrol drift is penned into ±62 and
          // would snap it back on the first ordinary tick. A hunt owns the full width.
          // It also settles the rhythm at patrol, patrol, patrol, hunt, charge - see the
          // count-up in the grounded AI, where the hunted swing is the one that reaches 5.
          e.hunting = true;
          if (!combatState.dead) showFloatingCombatText("IT CANNOT GUARD!", 160, 78, "#4ade80");
        }
      }
    }

    // One foe's turn: three ways of fighting, chosen off its variant config.
    //   circling (circler)     - laps a circle that dips into reach, then breaks off to swoop
    //   airborne (flyer)       - hovers out of reach, then swoops
    //   grounded (walker/boss/ - holds the floor, guards, and closes on the player
    //             swarmer)
    function tickEnemyAI(e) {
      const cfg = ENEMY_VARIANTS[e.variant] || ENEMY_VARIANTS.walker;
      if (e.blockTimer > 0) e.blockTimer--;
      // Frames left in the walker's post-attack opening (see reactiveBlock). Counts down every
      // frame, including through its own attack and stagger, so the window is real elapsed time.
      if (e.punishTimer > 0) e.punishTimer--;
      // Frames left with the guard forced down (the boss's charge recovery). Same deal - real
      // elapsed time, whatever the foe is doing with the rest of itself.
      if (e.noBlockTimer > 0) e.noBlockTimer--;
      // The strike frame belongs to ONE attack: from the blow (landEnemyStrike) to the moment
      // the foe leaves the attack state. Dropped here, ahead of anything below that could put
      // it back into that state, because the boss's rush is 'attack' for its whole run-in and
      // only lands at the end of it - a flag left over from its last swing would show the
      // impact before the charge had reached anyone.
      if (e.state !== 'attack') e.strikeLanded = false;

      // A boss mid-charge is not running the ordinary AI at all - see tickBossCharge.
      if (e.special && e.special !== 'none') { tickBossCharge(e, cfg); return; }

      if (cfg.orbitLift) {
        // Circler: instead of the flyer's hover it flies a circle - cos drives the drift across
        // the arena, sin drives the altitude - so it is out of reach over the top of the arc
        // and inside the player's 34px reach at the bottom of it. That is its whole weakness:
        // the flyer can only be hit during its own swoop, this one hands the player a window
        // on every lap. After CIRCLER_LAPS circles it breaks off and dives exactly like a
        // flyer, then climbs back into the slot it holds in the pack - same centre, same phase
        // it spawned with, so a pair is as fanned out on its tenth lap as on its first.
        if (e.state === 'hurt') {
          e.stateTimer--;
          if (e.stateTimer <= 0 && e.swoop === 'none') e.state = 'idle';
        }
        e.swoopTimer--;
        if (e.swoop === 'none') {
          e.orbit = (e.orbit + cfg.orbitSpeed) % (Math.PI * 2);
          // laps counts CIRCLES FLOWN, fractionally, rather than wraps of e.orbit - the two
          // are not the same thing for anyone whose slot phase isn't 0. The second of a pair
          // flies from pi, so its first wrap past 2pi comes half a circle in; counting wraps
          // would have it break off on a half lap, every lap.
          e.laps += cfg.orbitSpeed / (Math.PI * 2);
          e.x = e.homeX + Math.cos(e.orbit) * cfg.orbitRX;
          // Minus sin: the low point of the lap is at orbit = pi/2 and the high point at
          // 3pi/2, running 26..78 against the 34px reach cut-off in the player's strike - so
          // roughly a quarter of every circle has it inside the blade's reach.
          e.altitude = cfg.hover - Math.sin(e.orbit) * cfg.orbitLift;
          if (e.laps >= CIRCLER_LAPS && e.state !== 'hurt') {
            e.laps = 0;
            e.diveOffset = packDiveOffset(e);
            e.swoop = 'diving'; e.swoopTimer = 24; e.state = 'telegraph';
            showFloatingCombatText("⚠️ IT BREAKS OFF!", 160 + e.x * 0.5, 58, "#fbbf24");
          }
        } else if (e.swoop === 'diving') {
          e.altitude += (0 - e.altitude) * 0.22;
          // Aimed at its own place in the line rather than at the player exactly, so a pack
          // that breaks off together arrives shoulder to shoulder instead of stacking on the
          // one pixel the player is standing on - see packDiveOffset.
          e.x += ((combatState.playerX + (e.diveOffset || 0)) - e.x) * 0.16;
          if (e.swoopTimer <= 0) {
            e.swoop = 'striking'; e.swoopTimer = 14; e.state = 'attack';
            landEnemyStrike(e, cfg.dmg, "DODGED THE DIVE!", "🛡️ DIVE BLOCKED!", "DIVE!");
          }
        } else if (e.swoop === 'striking') {
          if (e.swoopTimer <= 0) { e.swoop = 'rising'; e.swoopTimer = 26; }
        } else if (e.swoop === 'rising') {
          // Climb back into the slot this one OWNS, not into wherever the dive left it. The
          // point it is rejoining at - its slot's centre, at its slot's phase - is flown to
          // across the whole 26-frame climb, x and altitude together, so the pattern is picked
          // up from the spot it is standing on and nothing teleports.
          // Re-centring the circle on its current x instead (what this used to do) is what
          // collapsed a pack: two circlers dive at the same target, so both came out of the
          // swoop with their circles centred on the same few pixels AND - the angle being
          // solved by acos from an x that was now its own centre, which is the same answer for
          // every one of them - sharing a phase as well. Perfect formation on spawn, one
          // sprite with two health bars from the first swoop on.
          const homeTX = e.slotX + Math.cos(e.orbitBase) * cfg.orbitRX;
          const homeTY = cfg.hover - Math.sin(e.orbitBase) * cfg.orbitLift;
          e.x += (homeTX - e.x) * 0.16;
          e.altitude += (homeTY - e.altitude) * 0.16;
          if (e.swoopTimer <= 0) {
            e.swoop = 'none'; e.state = 'idle';
            e.homeX = e.slotX;
            e.orbit = e.orbitBase;
            e.laps = 0;
          }
        }
      } else if (cfg.fly) {
        // Flyer: hovers high and out of reach, drifting side to side, until it commits to a
        // swoop - dive to the player, strike, climb back up.
        if (e.state === 'hurt') {
          e.stateTimer--;
          if (e.stateTimer <= 0 && e.swoop === 'none') e.state = 'idle';
        }
        e.swoopTimer--;
        if (e.swoop === 'none') {
          e.x += Math.sin(Date.now() / 620) * 1.3;
          e.altitude = cfg.hover + Math.sin(Date.now() / 300) * 5;
          if (e.swoopTimer <= 0 && e.state !== 'hurt') {
            e.swoop = 'diving'; e.swoopTimer = 26; e.state = 'telegraph';
            showFloatingCombatText("⚠️ SWOOP INCOMING!", 160, 58, "#fbbf24");
          }
        } else if (e.swoop === 'diving') {
          e.altitude += (0 - e.altitude) * 0.22;
          e.x += (combatState.playerX - e.x) * 0.14;
          if (e.swoopTimer <= 0) {
            e.swoop = 'striking'; e.swoopTimer = 14; e.state = 'attack';
            landEnemyStrike(e, cfg.dmg, "DODGED THE SWOOP!", "🛡️ SWOOP BLOCKED!", "SWOOP!");
          }
        } else if (e.swoop === 'striking') {
          if (e.swoopTimer <= 0) { e.swoop = 'rising'; e.swoopTimer = 26; }
        } else if (e.swoop === 'rising') {
          e.altitude += (cfg.hover - e.altitude) * 0.16;
          if (e.swoopTimer <= 0) {
            e.swoop = 'none'; e.swoopTimer = 80 + Math.floor(Math.random() * 60); e.state = 'idle';
          }
        }
      } else {
        // Walker, swarmer & boss: three ways of holding the ground. The walker stalks - it
        // creeps towards wherever the player is standing, and turns tail once it is badly
        // hurt. Its crawl is deliberately far slower than the player's 3.8px/frame strafe, so
        // the 44px dodge window in landEnemyStrike stays winnable - the pressure is that
        // standing still lets it close the gap.
        // The swarmer is that same stalk, quicker and without the nerve to break off, aimed at
        // its own slot in the pack (formOffset) rather than at the player's exact x so three of
        // them arrive spread out instead of single file.
        // The boss alternates instead: it drifts left/right for three haymakers (picking a
        // fresh direction after each), then hunts - steering straight at the player until it
        // lands the next one, then back to the drift. See the attack-resolution block below.
        // Its patrol is also much wider than it used to be. Penned into ±24 it could never
        // reach a player parked at the ±85 strafe limit - the gap stayed over that 44px dodge
        // threshold, so every haymaker scored as a miss and the edge of the arena was a free
        // camp. ±62 closes that, and a hunt gets the walker's full ±85 so following the player
        // means all the way to the wall.
        const range = cfg.slow ? (e.hunting ? 85 : 62) : 85;
        const spd = cfg.spd || (cfg.slow ? 0.5 : 0.9);
        // Below 30% HP a TIMID foe loses its nerve and backs away instead of closing. Only
        // the lone walker is: the boss never breaks off once it is hunting, and a swarmer
        // is meant to keep coming - three of them peeling away at 11 HP would turn the back
        // half of every swarm fight into a chase. A foe in full retreat also stops working
        // its guard (see reactiveBlock below) - it is running, not parrying - so a fled
        // walker can be put down instead of turtling backwards all the way to the wall.
        // A fled foe that keeps running for FLEE_ENRAGE_FRAMES straight gives up on retreat and
        // turns to fight instead - `enraged` latches for the rest of the bout (it only ever
        // triggers under 30% HP, so there is no "calm back down" to model). While it holds,
        // `flees` is forced false below so the foe charges instead of backing away.
        const wantsToFlee = cfg.timid && e.hp <= e.maxHp * 0.3;
        if (wantsToFlee && !e.enraged) {
          e.fleeTimer = (e.fleeTimer || 0) + 1;
          if (e.fleeTimer > FLEE_ENRAGE_FRAMES) {
            e.enraged = true;
            showFloatingCombatText("😡 ENRAGED!", 160, 58, "#f87171");
          }
        } else if (!wantsToFlee) {
          e.fleeTimer = 0;
        }
        const flees = wantsToFlee && !e.enraged;
        if (e.state !== 'attack' && e.state !== 'telegraph') {
          if (!cfg.slow || e.hunting) {
            const gap = (combatState.playerX + (e.formOffset || 0)) - e.x;
            const toward = gap < 0 ? -1 : 1;
            // A hunt closes faster than the patrol drift, but 0.8px/frame is still a fifth of
            // the player's 3.8px strafe - it is outrunnable, just not ignorable. Enraged closes
            // faster still - it gave up running, so it commits to catching the player.
            const chaseMult = e.enraged ? ENRAGE_SPEED_MULT : (e.hunting ? 1.6 : 1);
            e.vx = (flees ? -toward : toward) * spd * chaseMult;
            // Don't jitter once it is already standing on its mark.
            if (Math.abs(gap) < 6 && !flees) e.vx = 0;
          }
          e.x += e.vx;
          if (e.x > range) { e.x = range; e.vx = -Math.abs(e.vx); }
          else if (e.x < -range) { e.x = -range; e.vx = Math.abs(e.vx); }
          if (combatState.enemies.length > 1) separatePack(e);
        }

        if (e.state === 'hurt' || e.state === 'attack') {
          e.stateTimer--;
          if (e.stateTimer <= 0) e.state = 'idle';
        } else {
          e.attackTimer--;
          // Raising the guard between attacks. While blockTimer runs the renderer swaps in
          // that foe's generated block frame, and a player strike caught on it does no damage
          // (see the player-strike resolution).
          if (cfg.reactiveBlock) {
            // The walker doesn't gamble - it reacts. The player's swing lands on ATTACK_HIT_FRAME;
            // catching it as early as frame 2 reads as the foe answering it. It guards through
            // its own wind-up too, so swinging AT the telegraph just gets blocked - the only
            // gap is punishTimer, the beat after its own attack when it can't get the guard up.
            // Once it breaks and runs (flees) the guard stops coming up at all, and any guard
            // already raised drops - a foe in full retreat is running, not parrying.
            if (flees) {
              e.blockTimer = 0;
            } else if ((e.state === 'idle' || e.state === 'telegraph') && e.punishTimer <= 0
                && e.noBlockTimer <= 0
                && combatState.attackFrame >= 2 && combatState.attackFrame < ATTACK_HIT_FRAME) {
              e.blockTimer = cfg.blockHold || 60;
            }
          } else if (cfg.canBlock && e.state === 'idle' && e.blockTimer <= 0 && e.noBlockTimer <= 0
              && Math.random() < (cfg.blockOdds || 0)) {
            // Boss (and anything else with blockOdds): an occasional random guard. The swarmer
            // has none at all - blockOdds 0 - which is most of what makes a pack of them killable.
            e.blockTimer = cfg.blockHold || 75;
            showFloatingCombatText("ENEMY GUARDS", 160 + e.x, 78, "#94a3b8");
          }
          // Last Attack Frame's QUICK mode has no wind-up at all: no telegraph state, so no early
          // attack frame and no callout - the foe keeps its ordinary stance (and keeps stalking)
          // right up to the tick below where the blow lands, and the attack frame arrives with it.
          // The clock is left alone, so the blow lands on exactly the tick it would have: Quick
          // changes when the pose shows, not how often the foe swings. (Mixed plays Quick here -
          // everything on this path is on the ground; see attackFrameModeFor.)
          if (e.attackTimer === cfg.telegraph && attackFrameModeFor(e) !== 'quick') {
            e.state = 'telegraph';
            // A pack telegraphs with a bare glyph over its own head: three swarmers winding up
            // every second would otherwise bury the screen in "ENEMY WIND-UP!".
            if ((cfg.group || 1) > 1) {
              showFloatingCombatText("⚠️", 160 + e.x, 88, "#fbbf24");
            } else {
              showFloatingCombatText(cfg.slow ? "⚠️ HEAVY WIND-UP!" : "⚠️ ENEMY WIND-UP!", 160, 75, "#fbbf24");
            }
          } else if (e.attackTimer <= 0) {
            // Enraged skips the usual cadence roll and comes back around fast - lots of
            // attacks, one on top of the next, instead of the normal breathing room.
            e.attackTimer = e.enraged ? Math.round(cfg.cadence * ENRAGE_CADENCE_MULT)
              : cfg.cadence + Math.floor(Math.random() * 50);
            e.state = 'attack';
            e.stateTimer = cfg.slow ? 20 : 14;
            e.blockTimer = 0;
            // The walker's guard is down for punishWindow frames now - this swing is what opens
            // it. Set here (on the commit) rather than when the blow lands, so even a dodged or
            // whiffed enemy swing still leaves the gap.
            if (cfg.reactiveBlock) e.punishTimer = cfg.punishWindow || 70;
            // Boss rhythm: three swings thrown from the drifting left/right patrol, then it
            // stops wandering and walks the player down for one hunted swing - after which
            // the count resets and the patrol resumes. Riding out the patrol phase at the
            // wall is survivable; riding out the hunt there is not.
            if (cfg.slow) {
              // Every BOSS_CHARGE_EVERY swings, the patrol/hunt rhythm is put aside and the
              // charge takes over (tickBossCharge). Counted on the COMMIT, alongside everything
              // else here, so a swing the player dodged still carries it towards the set piece -
              // the charge is a clock the player cannot stall by staying out of the way.
              // This swing still lands: the boss withdraws out of its own follow-through.
              if (++e.chargeCount >= BOSS_CHARGE_EVERY) {
                e.chargeCount = 0;
                e.special = 'back';
                e.specialTimer = BOSS_BACK_FRAMES;
                e.blockTimer = 0;
                e.hunting = false;
                e.atkCount = 0;
                showFloatingCombatText("⚠️ IT PULLS BACK!", 160, 58, "#f87171");
              } else if (e.hunting) {
                e.hunting = false;      // that was the hunt's payoff - back to patrolling
                e.atkCount = 0;
              } else if (++e.atkCount >= 3) {
                e.hunting = true;
                showFloatingCombatText("⚠️ IT HUNTS YOU!", 160, 66, "#f87171");
              }
              // Coin-flip which way the boss lumbers off after the swing, so the next
              // wind-up doesn't always come from the same side. While hunting this is
              // immediately overwritten next frame by the steer-toward-player above.
              e.vx = (Math.random() < 0.5 ? -spd : spd);
            }
            landEnemyStrike(e, cfg.dmg, "DODGED! (MISS)", "🛡️ PARRY BLOCKED!", cfg.slow ? "CRUSH!" : "HP HIT!");
          }
        }
      }
    }

    // Stamina recovery and the exhaustion look that rides on it. Split out of combatTick() because
    // it is the one part of the sim that must keep running while the rest is frozen: the win
    // outro, the level-up box and the ending cutscene all stop the world, and a hero who won the
    // fight out of breath used to sit behind them with a full bar still flashing its red
    // "can't swing" warning - the flash keys off exhaustion, which only eased back to zero here.
    // Nothing can spend stamina while those freezes hold (held keys are released and the guard
    // drain lives behind battleReady()), so letting it recover under them changes no fight.
    function tickStamina() {
      // An overexertion lock outranks everything: while it runs the bar is HELD at zero rather
      // than left to climb, so the two seconds it costs are two seconds of no swing, no guard
      // and a staggering strafe no matter what the player does with the keys. It also ticks
      // down out of battle, so fleeing a fight does not skip the debt - it just spends it
      // walking the corridor instead.
      //
      // Otherwise: only an ACTIVE block suppresses regen. Gating on keysHeld.block alone meant a
      // block flag that never got cleared left stamina pinned just above zero forever.
      if (combatState.exhaustLock > 0) {
        combatState.exhaustLock--;
        combatState.playerStm = 0;
      } else if (!(combatState.inBattle && keysHeld.block) && combatState.playerStm < combatState.playerMaxStm) {
        // 0.45/tick is 27/s - a full base bar in under four seconds. SPEED picks scale it, so
        // the pick buys swings-per-fight as much as it buys footwork.
        combatState.playerStm = Math.min(combatState.playerMaxStm,
          combatState.playerStm + 0.45 * playerSpeedMult());
      }

      // How wrecked the hero LOOKS. Nothing reads this to decide what they may do - the action
      // gates are still playerStm against ATTACK_STM_COST / BLOCK_STM_FLOOR in combatTick() - it
      // only drives the drawing (drawOverTheShoulderPlayer, renderDoomFace, the STM bar).
      //
      // It snaps to 0.45 the instant a swing becomes unaffordable rather than easing up from
      // nothing, because that is the moment the player loses the fight's main verb and the
      // sprite has to say so; from there it deepens to a fully spent 1.0 as the bar bottoms
      // out and even the guard drops. Lerped rather than assigned so the pose eases in and out
      // over ~1/4s instead of popping on the frame stamina crosses the line - regen refills
      // the last 30 in about a second, and a hard switch flickered.
      const spentTarget = (combatState.playerStm >= ATTACK_STM_COST || combatState.dead) ? 0
        : 0.45 + 0.55 * (1 - combatState.playerStm / ATTACK_STM_COST);
      combatState.exhaustion += (spentTarget - combatState.exhaustion) * 0.12;
      if (Math.abs(spentTarget - combatState.exhaustion) < 0.004) combatState.exhaustion = spentTarget;
    }

    // One fixed 1/60s step of combat. Pure simulation - no drawing, no DOM.
    function combatTick() {
      // The level-up box stops the world, not just the input: no floating text ageing, no enemy
      // clock. It only ever opens between fights, but a frozen sim means the dungeon is exactly
      // as it was left when the choice is taken.
      // The ending cutscene stops it the same way, for a different reason: the fight it replaced
      // must not finish itself behind the clip - no XP payout raising the level-up box over it,
      // no hand-back to exploration fading the dungeon's bed in under its soundtrack.
      // Stamina alone keeps recovering under both - see tickStamina().
      if (levelUpOpen || endingOwnsViewport()) {
        tickStamina();
        return;
      }

      if (combatState.inBattle && combatState.introFrame < INTRO_TOTAL) {
        combatState.introFrame++;
      }

      // Corpse dissolve, per foe. A pack member starts dithering out the moment it drops while
      // the rest of its pack fights on, so this can no longer be "the enemy is fading" - the
      // dungeon only comes back once every one of them is down AND the last corpse has
      // finished dissolving.
      // Not while the ending cutscene's cut is pending: the beaten boss is being held on screen for
      // it, so there is no corpse to dissolve, and the hero's win outro (fading them out, "LEVEL
      // UP!") must not start in the beat before the clip takes over.
      if (combatState.inBattle && combatState.enemies.length && !combatState.dead && endingPhase !== 'pending') {
        let stillFading = false, allDown = true;
        for (const e of combatState.enemies) {
          if (e.deathFade > 0) {
            e.deathFade++;
            if (e.deathFade <= DEATH_FADE_FRAMES + DEATH_FADE_HOLD) stillFading = true;
          } else if (e.hp > 0) {
            allDown = false;
          }
        }
        if (allDown && !stillFading) {
          // Every foe is gone; now the hero's own outro plays before the dungeon returns. On
          // the first tick, latch whether this win crosses a level threshold - that decides
          // between the dithering fade-out (playerWinVisibility) and staying on screen for the
          // joy hop (drawOverTheShoulderPlayer). Either way the sim stays frozen, the same as a
          // death or the level-up box, until the outro's tick count is spent.
          if (combatState.winTick === 0) {
            combatState.winIsLevelUp =
              (progression.xp + combatState.pendingXp) >= progression.xpToNext;
            if (combatState.winIsLevelUp) showFloatingCombatText("LEVEL UP!", 160, 70, "#fde047");
            // Settle the hero: a strafe held into the killing blow otherwise leaves them
            // leaning and walk-bobbing through the send-off.
            combatState.vx = 0;
            combatState.attackFrame = 0;
            combatState.hurtFrame = 0;
            combatState.shieldProgress = 0;
            releaseHeldKeys();
            setCombatButtonsLive(false);   // grey out Strike/Block/Strafe - the fight is won
          }
          combatState.winTick++;
          const outroLen = combatState.winIsLevelUp
            ? WIN_JOY_HOP_FRAMES
            : WIN_FADE_DELAY + WIN_FADE_FRAMES + WIN_FADE_HOLD;
          tickStamina();
          updateCombatEffects();
          if (combatState.winTick >= outroLen) finishEncounterVictory();
          return;
        }
      }

      if (battleReady() && !combatState.dead) {
        // An empty bar staggers. Movement is the last thing left to a spent hero - the swing
        // and the guard are both gone by this point - so it is slowed, not removed.
        //
        // Two modifiers ride on top. SPEED picks scale it; a raised guard halves it. The guard
        // test is the SAME condition the shield itself comes up on below, so the slowdown and
        // the protection start and stop on exactly the same frame - a hold that is too cheap to
        // raise a shield (bar at or under BLOCK_STM_FLOOR) does not cost mobility either.
        const guarding = keysHeld.block && combatState.playerStm > BLOCK_STM_FLOOR;
        let strafe = (combatState.playerStm > 0 ? 3.8 : EXHAUSTED_STRAFE_SPEED) * playerSpeedMult();
        if (guarding) strafe *= GUARD_STRAFE_FACTOR;
        if (keysHeld.left) {
          combatState.vx = -strafe;
          combatState.glanceDir = -1;
          combatState.playerFacing = -1;
        } else if (keysHeld.right) {
          combatState.vx = strafe;
          combatState.glanceDir = 1;
          combatState.playerFacing = 1;
        } else {
          combatState.vx *= 0.65;
        }
        combatState.playerX = Math.max(-85, Math.min(85, combatState.playerX + combatState.vx));

        // BLOCK_STM_FLOOR is what makes "the guard does not come up on an empty bar" true, and
        // it is why an overexertion lock leaves the hero defenceless for its full two seconds:
        // the bar is pinned at 0 below, so this test cannot pass until the lock expires.
        if (guarding) {
          combatState.shieldProgress = Math.min(1.0, combatState.shieldProgress + 0.2);
          // Holding guard costs stamina; shuffling around while guarding costs much more.
          const guardMoving = keysHeld.left || keysHeld.right;
          combatState.playerStm = Math.max(0, combatState.playerStm - (guardMoving ? 0.85 : 0.3));
          combatState.faceState = 'block';
        } else {
          combatState.shieldProgress = Math.max(0.0, combatState.shieldProgress - 0.2);
        }
      }

      tickStamina();

      if (combatState.attackFrame > 0) {
        // SPEED picks play the whole swing out faster - wind-up, the blow at ATTACK_HIT_FRAME
        // and the recovery that follows it all compress together, so the counter steps by a
        // fraction rather than by 1. Everything downstream reads attackFrame as a position in
        // the animation (the sprite picker divides it by maxAttackFrames, the walker's reactive
        // guard watches for it inside a window), so a fractional step is fine there - only the
        // hit itself needed the equality test turned into a crossing.
        const prevAttackFrame = combatState.attackFrame;
        combatState.attackFrame += playerSpeedMult();
        if (prevAttackFrame < ATTACK_HIT_FRAME && combatState.attackFrame >= ATTACK_HIT_FRAME) {
          // Who the swing lands on. Against a lone foe that is the only answer; against a pack
          // it is the NEAREST one the blade can actually reach - and "reach" is three tests,
          // not one: not airborne over the 34px line, not withdrawn past REACH_DEPTH, and
          // lined up within SWING_REACH + the variant's bodyR horizontally. A swarmer that has
          // flanked wide, or a foe the player is strafing out from under, is now a clean miss.
          const living = combatState.enemies.filter(k => k.hp > 0);
          let e = null;
          let anyInFront = false;   // a foe low and near enough to cut, if only the aim were on it
          for (const k of living) {
            const kcfg = ENEMY_VARIANTS[k.variant] || ENEMY_VARIANTS.walker;
            if (kcfg.fly && k.altitude > 34) continue;
            // ...and a foe that has pulled back off the front line is out of reach the other
            // way. A charging boss spends every phase but the run-in behind this line, so the
            // whole wind-up is something the player can only answer with their feet.
            if ((k.depth || 0) > REACH_DEPTH) continue;
            // Horizontal alignment. Past here is a foe the blade could touch if the player
            // stood in the right place, so whiffing on this is a positioning mistake (step
            // across and try again) rather than a wait - the "MISSED!" below says so.
            if (Math.abs(combatState.playerX - k.x) > SWING_REACH + (kcfg.bodyR || 22)) { anyInFront = true; continue; }
            if (!e || Math.abs(combatState.playerX - k.x) < Math.abs(combatState.playerX - e.x)) e = k;
          }
          if (living.length && !e) {
            // The weapon whooshing through air, not a sound the enemy makes - no cfg.sfxRate
            // pitch, unlike hit_enemy/block/death_enemy below. "MISSED!" when there was a foe
            // on the ground in front to line up on; "OUT OF REACH!" when everything left is
            // airborne or withdrawn and the answer is to wait, not to shuffle sideways.
            playSfx('miss_enemy');
            showFloatingCombatText(anyInFront ? "MISSED!" : "OUT OF REACH!", 160, 90, "#93c5fd");
          } else if (e) {
            const cfg = ENEMY_VARIANTS[e.variant] || ENEMY_VARIANTS.walker;
            if (e.blockTimer > 0) {
              // Caught on the guard: nothing lands - no HP lost, no stagger. The walker keeps
              // its guard through it (reactiveBlock); every other foe drops it, so the boss
              // fight stays a rhythm of blocked-then-clean swings instead of a wall.
              if (!cfg.reactiveBlock) e.blockTimer = 0;
              showFloatingCombatText("BLOCKED!",
                160 + e.x * 0.6 + (Math.random() * 20 - 10), 100, "#94a3b8");
              // Pitched by cfg.sfxRate - see ENEMY_VARIANTS - the boss's boom, the flyer's yelp.
              playSfx('block', { rate: cfg.sfxRate });
            } else {
              // STRENGTH picks ride on the base roll, so +4 is +4 through armour too (which
              // scales the total) rather than a flat bonus that dwarfs it.
              let dmg = 24 + progression.bonusAtk + Math.floor(Math.random() * 12);
              if (cfg.slow) dmg = Math.floor(dmg * 0.7);   // boss is armoured
              e.hp = Math.max(0, e.hp - dmg);
              e.state = 'hurt';
              e.stateTimer = 12;
              // Anchored on the foe that was actually hit rather than on the centre line, so in
              // a pack the number appears over the one that took it.
              showFloatingCombatText(`-${dmg} SLASH!`,
                160 + e.x * 0.6 + (Math.random() * 20 - 10), 100, "#f87171");
              playSfx('hit_enemy', { rate: cfg.sfxRate });

              if (e.hp <= 0) {
                e.blockTimer = 0;
                // The boss's health is gone - with a cutscene in hand, the ending takes it from here.
                // The boss does NOT dissolve then: the clip opens on it standing, so a corpse that
                // vanished only to be back on screen a moment later read as a glitch. It reels,
                // held in its hurt look (see endingHold in drawEnemyBody), until the cut. Without a
                // clip nothing changes: the corpse dissolves and the stairs are the ending.
                if (e.variant === 'boss' && startEndingCutscene()) {
                  e.state = 'hurt';
                  e.endingHold = true;
                } else {
                  e.state = 'defeated';
                  // Starts the dither-out. combatTick counts it up and calls
                  // finishEncounterVictory() once every corpse has fully dissolved.
                  e.deathFade = 1;
                }
                // Same species, several sizes: one death cry serves every variant, pitched by
                // cfg.sfxRate to sell the flyer's smaller frame or the boss's bulk.
                playSfx('death_enemy', { rate: cfg.sfxRate });
                // Banked, not assigned: a pack pays out once, for all of them, when the last
                // corpse finishes dissolving.
                const xp = ENEMY_XP[e.variant] || ENEMY_XP.walker;
                combatState.pendingXp += xp;
                const left = combatState.enemies.filter(k => k.hp > 0).length;
                showFloatingCombatText(
                  left ? `DOWN! +${xp} XP (${left} LEFT)` : `VICTORY! +${combatState.pendingXp} XP`,
                  160, 70, "#fde047");
              }
            }
          }
        }
        if (combatState.attackFrame > combatState.maxAttackFrames) {
          combatState.attackFrame = 0;
        }
      }

      if (combatState.hurtFrame > 0) {
        combatState.hurtFrame++;
        if (combatState.hurtFrame > combatState.maxHurtFrames) {
          combatState.hurtFrame = 0;
        }
      }

      if (combatState.faceTimer > 0) {
        combatState.faceTimer--;
        if (combatState.faceTimer <= 0) combatState.faceState = 'idle';
      }

      combatState.glanceTimer--;
      if (combatState.glanceTimer <= 0) {
        const r = Math.random();
        combatState.glanceDir = r < 0.25 ? -1 : r < 0.5 ? 1 : 0;
        combatState.glanceTimer = 60 + Math.floor(Math.random() * 80);
      }

      // battleReady(), not inBattle: a foe still dithering into existence does not get to
      // swing. Every living foe on the field takes its turn - a lone walker is a pack of one.
      if (battleReady() && !combatState.dead) {
        for (const e of combatState.enemies) {
          // The pack shares a tick, so the blow that kills the player can be followed by two
          // more from foes further down the array. Stop the moment the hero is down.
          if (combatState.dead) break;
          if (e.hp > 0) tickEnemyAI(e);
        }
        // After the whole pack has moved, not inside its own turn: separatePack shoves the
        // foe's neighbours as well as the foe itself.
        for (const e of combatState.enemies) if (e.hp > 0) updateEnemyFacing(e);
      }

      updateCombatEffects();
    }

    // One displayed frame: catch the simulation up to real elapsed time, then draw once.
    //
    // Drawing lives out here rather than inside combatTick() so a slow raycast can never starve
    // the combat clock - a 40ms render just means the next frameTime is 40ms and the accumulator
    // spends it on three ticks. Also on rAF rather than setInterval so it parks properly when the
    // tab is hidden instead of raycasting an invisible canvas at whatever rate the browser allows.
    function combatFrame(now) {
      requestAnimationFrame(combatFrame);

      // Off-stage (setup / generation / menu screens). Reset the clock as well as bailing, so
      // coming back doesn't fire a burst of catch-up ticks for time the fight was never on screen.
      if (!screenGame || screenGame.classList.contains('hidden')) {
        simLastTime = now;
        simAccumulator = 0;
        return;
      }

      let frameTime = now - simLastTime;
      simLastTime = now;
      // A long stall - backgrounded tab, GC pause, texture generation - must not translate into
      // hundreds of queued ticks fast-forwarding the fight. Cap the debt at a quarter second.
      if (frameTime > 250) frameTime = 250;
      simAccumulator += frameTime;

      let steps = 0;
      while (simAccumulator >= SIM_STEP && steps < MAX_SIM_STEPS) {
        combatTick();
        simAccumulator -= SIM_STEP;
        steps++;
      }
      // Still behind after MAX_SIM_STEPS means the machine genuinely can't keep up. Drop the
      // backlog and let combat run in slow motion rather than spiral trying to catch up.
      if (steps === MAX_SIM_STEPS) simAccumulator = 0;

      // Nothing below this line changes the game - it only paints it - so everything below is
      // skippable. Three reasons to skip:
      //
      //  - The screensaver is up and covering the whole window. Raycasting a dungeon nobody
      //    can see was pure waste (and it never comes up mid-fight: a live battle counts as
      //    activity, so the starfield can't cut in over one).
      //  - A move or turn tween is running. It owns the viewport for its 160ms (see animate3D)
      //    and takes the frame budget for itself, so bailing here rather than after the cap
      //    check is what leaves the slot for it to spend.
      //  - We are already at the player's chosen frame rate ceiling.
      if (screensaverActive) return;
      if (player.isAnimating) return;
      if (!viewportFrameAllowed(now)) return;

      if (playerHpBar) playerHpBar.style.width = `${(combatState.playerHp / combatState.playerMaxHp) * 100}%`;
      if (playerHpText) playerHpText.textContent = `${Math.ceil(combatState.playerHp)}/${combatState.playerMaxHp}`;
      if (playerStmBar) {
        playerStmBar.style.width = `${(combatState.playerStm / combatState.playerMaxStm) * 100}%`;
        // Past the point where a swing is affordable the bar stops reporting how much is left
        // and starts warning: it flips from green to a flashing red. Cleared back to '' rather
        // than to a colour, so the bar returns to its bg-green-500 class.
        playerStmBar.style.backgroundColor = combatState.exhaustion > 0.15
          ? (Math.floor(Date.now() / 200) % 2 ? '#ef4444' : '#7f1d1d')
          : '';
      }
      if (playerStmText) playerStmText.textContent = `${Math.ceil(combatState.playerStm)}/${combatState.playerMaxStm}`;

      renderDoomFace();
      // Nothing to raycast under the ending cutscene - it covers the whole viewport.
      if (activeMode !== 'v1_video' && !endingOwnsViewport()) {
        render3D();
      }
    }
    requestAnimationFrame(combatFrame);

    function renderDoomFace() {
      if (!doomFaceCtx) return;
      const c = doomFaceCtx;
      // Every coordinate below is authored against the original 44x44 portrait. Scaling the
      // context once here lets the canvas be backed at a much higher resolution (so the bigger
      // on-screen portrait stays crisp) without touching any of that drawing maths. setTransform
      // rather than save/restore, because this function has early returns.
      const S = doomFaceCanvas.width / 44;
      c.setTransform(S, 0, 0, S, 0, 0);
      c.clearRect(0, 0, 44, 44);

      // A dead hero holds the hurt frame until the run restarts. faceState decays back to
      // 'idle' on a timer (killPlayer sets ~16s of it), which would otherwise blank the wound
      // out from under the death box - and off the frozen portrait behind the screensaver.
      const isHurt = combatState.dead || combatState.faceState === 'hurt' || combatState.hurtFrame > 0;
      const isAttack = combatState.faceState === 'attack' || combatState.attackFrame > 0;
      const isBlock = combatState.shieldProgress > 0.5;
      // Spent sits BELOW the three action states: whatever the hero is doing this instant wins
      // the expression, and the portrait dim is what is left over when they are doing nothing
      // because there is nothing left to do it with. Cleared while dead and through a win outro,
      // to match the body (drawOverTheShoulderPlayer) - a corpse and a celebrating winner both
      // shed the winded look.
      const spent = (combatState.dead || combatState.winTick > 0) ? 0 : combatState.exhaustion;
      const isSpent = spent > 0.35;

      // Pick the expression that matches what the player is doing. Hurt wins over attack, which
      // wins over block, matching the priority the body sprite uses. An empty stamina bar does
      // NOT pull the hurt face - being winded is not being wounded - it only shades the portrait
      // below, leaving the drained body sprite and the amber border to carry the "can't swing" read.
      let face = playerFaceImg;
      if (playerFaceFrames.length > 1) {
        const idx = isHurt ? 3 : isAttack ? 1 : isBlock ? 2 : 0;
        face = playerFaceFrames[idx] || playerFaceFrames[0];
      }

      if (face && face.complete && face.naturalWidth > 0) {
        c.drawImage(face, 2, 2, 40, 40);
        // Winded: a little shade over the portrait, deepening as the bar bottoms out.
        if (isSpent) {
          c.fillStyle = 'rgba(2, 6, 23, ' + (spent * 0.28).toFixed(2) + ')';
          c.fillRect(2, 2, 40, 40);
        }

        // Combat state is shown ONLY through the border colour. Full-portrait tints used to be
        // laid over the face too, but the per-frame krea2 expressions now carry the state
        // (open-mouthed for attack, eyes shut for hurt, and so on), and the coloured wash just
        // muddied a portrait that is already doing the job. Pupils / eyebrows / mouth painted at
        // fixed coordinates were dropped earlier for the same reason - the portrait can be hooded,
        // feline, helmeted or masked, so nothing can be drawn on top at a fixed spot.
        // Amber, and pulsing, when spent: distinct from the attack frame's steady bright amber
        // and from the hurt frame's red, and moving enough to be noticed from the corner of the
        // eye - which is the point, since it is the state that says "you cannot swing".
        c.strokeStyle = isHurt ? '#ef4444' : isAttack ? '#f59e0b' : isBlock ? '#38bdf8'
                      : isSpent ? (Math.floor(Date.now() / 240) % 2 ? '#a16207' : '#57534e')
                      : '#64748b';
        c.lineWidth = 2;
        c.strokeRect(1, 1, 42, 42);
        return;
      }

      // Procedural fallback
      c.fillStyle = '#0f172a';
      c.fillRect(0, 0, 44, 44);
      c.fillStyle = isHurt ? '#fca5a5' : '#fed7aa';
      c.fillRect(10, 10, 24, 26);
      c.fillStyle = '#1e3a8a';
      c.fillRect(14, 20, 4, 3);
      c.fillRect(26, 20, 4, 3);
      if (isSpent) {
        c.fillStyle = 'rgba(2, 6, 23, ' + (spent * 0.28).toFixed(2) + ')';
        c.fillRect(0, 0, 44, 44);
      }
      c.strokeStyle = isHurt ? '#ef4444' : isSpent ? '#a16207' : '#64748b';
      c.lineWidth = 2;
      c.strokeRect(1, 1, 42, 42);
    }

    // ========================================================
    // VALBRACE ACCURATE MODULAR COMBAT RIG (v6)
    // ========================================================

    // 1. MODULAR WEAPON (RIGHT HAND - VALBRACE STYLE)
        // 1. MODULAR WEAPON (RIGHT HAND - VALBRACE STYLE)
    function drawModularWeapon(c, attFrame, isMoving, walkBob, shieldProgress) {
      c.save();

      if (attFrame === 0) {
        const hx = rig.swordX;
        const hy = rig.swordY + (isMoving ? walkBob * 0.5 : 0) + (shieldProgress * 4);
        const tilt = shieldProgress * 0.35;
        c.translate(hx, hy);
        c.rotate(tilt);

        c.fillStyle = '#ca8a04';
        c.beginPath(); c.arc(0, 14, 3.5, 0, Math.PI * 2); c.fill();
        c.fillStyle = '#78350f';
        c.fillRect(-2.5, 0, 5, 14);

        c.fillStyle = '#facc15';
        c.beginPath();
        c.moveTo(-14, 0); c.bezierCurveTo(-6, -4, 6, -4, 14, 0);
        c.lineTo(14, 4); c.bezierCurveTo(6, 0, -6, 0, -14, 4);
        c.closePath(); c.fill();
        c.strokeStyle = '#a16207'; c.lineWidth = 1; c.stroke();

        c.fillStyle = '#ffffff';
        c.beginPath();
        c.moveTo(-3.5, 0); c.lineTo(-2.5, -58); c.lineTo(0, -66); c.lineTo(2.5, -58); c.lineTo(3.5, 0);
        c.closePath(); c.fill();
        c.strokeStyle = '#38bdf8'; c.lineWidth = 1.5; c.stroke();

        c.strokeStyle = '#fef08a'; c.lineWidth = 1;
        c.beginPath(); c.moveTo(0, 0); c.lineTo(0, -60); c.stroke();

        // NO FAKE HAND - Sword is drawn behind the player's real arm!

      } else if (attFrame <= 4) {
        const hx = rig.swordX + 7;
        const hy = rig.swordY - 4;
        c.translate(hx, hy);
        c.rotate(Math.PI / 3.2);

        c.fillStyle = '#78350f'; c.fillRect(-2.5, 0, 5, 14);
        c.fillStyle = '#facc15'; c.fillRect(-12, -2, 24, 4);
        c.fillStyle = '#ffffff';
        c.beginPath();
        c.moveTo(-3.5, -2); c.lineTo(-2.5, -58); c.lineTo(0, -66); c.lineTo(2.5, -58); c.lineTo(3.5, -2);
        c.closePath(); c.fill();
        c.strokeStyle = '#38bdf8'; c.lineWidth = 1.5; c.stroke();

      } else if (attFrame <= 9) {
        const progress = (attFrame - 5) / 4;
        c.strokeStyle = 'rgba(255, 255, 255, 0.95)'; c.lineWidth = 6;
        c.beginPath(); c.moveTo(rig.swordX + 7, -20); c.quadraticCurveTo(rig.swordX + 15, -85, -35, -95); c.stroke();

        c.strokeStyle = 'rgba(56, 189, 248, 0.85)'; c.lineWidth = 3;
        c.beginPath(); c.moveTo(rig.swordX + 7, -20); c.quadraticCurveTo(rig.swordX + 15, -85, -35, -95); c.stroke();

        const bladeAngle = Math.PI / 4 - (progress * Math.PI * 0.85);
        const bx = 20 - (progress * 36);
        const by = -45 - (Math.sin(progress * Math.PI) * 22);

        c.save();
        c.translate(bx, by);
        c.rotate(bladeAngle);
        c.fillStyle = '#ffffff'; c.fillRect(-3, -58, 6, 58);
        c.strokeStyle = '#0284c7'; c.lineWidth = 1.5; c.strokeRect(-3, -58, 6, 58);
        c.restore();

        c.fillStyle = '#fde047';
        c.beginPath(); c.arc(0, -90, 15, 0, Math.PI * 2); c.fill();

      } else if (attFrame <= 13) {
        const hx = rig.swordX - 21;
        const hy = rig.swordY - 28;

        c.fillStyle = '#ffffff';
        c.beginPath();
        c.moveTo(hx - 3.5, hy + 20); c.lineTo(hx - 2, hy - 28); c.lineTo(hx, hy - 38); c.lineTo(hx + 2, hy - 28); c.lineTo(hx + 3.5, hy + 20);
        c.closePath(); c.fill();
        c.strokeStyle = '#0284c7'; c.lineWidth = 1.5; c.stroke();

        c.fillStyle = '#facc15'; c.fillRect(hx - 10, hy + 18, 20, 4);

      } else {
        const progress = (attFrame - 14) / 4;
        const hx = rig.swordX + ((1.0 - progress) * 5);
        const hy = rig.swordY - ((1.0 - progress) * 6);

        c.fillStyle = '#ffffff';
        c.save();
        c.translate(hx, hy);
        c.rotate(Math.PI / 6 * (1.0 - progress));
        c.fillRect(-2.5, -52, 5, 52);
        c.fillStyle = '#facc15'; c.fillRect(-8, -2, 16, 4);
        c.restore();
      }

      c.restore();
    }

    // 2. MODULAR SHIELD (LEFT HAND - VALBRACE STYLE)
    function drawModularShield(c, shieldProgress) {
      c.save();

      if (shieldProgress > 0.1) {
        // --- VALBRACE SHIELD RAISED UP TO HEAD / CHEST (Valbrace Image 4) ---
        // Smoothly rises from Left Flank (-28, -32) to Center High Guard (0, -68)
        const sx = -28 + (shieldProgress * 28);
        const sy = -32 - (shieldProgress * 36);
        const sw = 26 + (shieldProgress * 12);
        const sh = 34 + (shieldProgress * 14);

        c.translate(sx, sy);

        // Rectangular Curved Kite Shield
        const gradShield = c.createLinearGradient(-sw/2, -sh/2, sw/2, sh/2);
        gradShield.addColorStop(0, '#1e3a8a');
        gradShield.addColorStop(0.5, '#3b82f6');
        gradShield.addColorStop(1, '#0f172a');
        c.fillStyle = gradShield;

        c.beginPath();
        c.moveTo(-sw/2, -sh/2);
        c.lineTo(sw/2, -sh/2);
        c.lineTo(sw/2, sh/4);
        c.lineTo(0, sh/2); // Pointed Bottom
        c.lineTo(-sw/2, sh/4);
        c.closePath();
        c.fill();

        c.strokeStyle = '#facc15';
        c.lineWidth = 3;
        c.stroke();

        // Steel Boss Emblem
        c.fillStyle = '#f8fafc';
        c.beginPath(); c.arc(0, 0, 5, 0, Math.PI * 2); c.fill();
        c.strokeStyle = '#64748b'; c.lineWidth = 1; c.stroke();

        // Glowing Blue Parry Energy Barrier
        c.strokeStyle = `rgba(56, 189, 248, ${shieldProgress * 0.9})`;
        c.lineWidth = 4;
        c.beginPath();
        c.arc(0, 0, sw/2 + 6, 0, Math.PI * 2);
        c.stroke();

      } else {
        // --- NEUTRAL RESTING SHIELD AT LEFT FLANK (Valbrace Image 2 & 3) ---
        const sx = rig.shieldX;
        const sy = rig.shieldY;
        const sw = 24;
        const sh = 34;

        c.translate(sx, sy);

        const gradShield = c.createLinearGradient(-sw/2, -sh/2, sw/2, sh/2);
        gradShield.addColorStop(0, '#1e3a8a');
        gradShield.addColorStop(0.5, '#2563eb');
        gradShield.addColorStop(1, '#0f172a');
        c.fillStyle = gradShield;

        c.beginPath();
        c.moveTo(-sw/2, -sh/2);
        c.lineTo(sw/2, -sh/2);
        c.lineTo(sw/2, sh/4);
        c.lineTo(0, sh/2);
        c.lineTo(-sw/2, sh/4);
        c.closePath();
        c.fill();

        c.strokeStyle = '#facc15';
        c.lineWidth = 2.5;
        c.stroke();
      }

      c.restore();
    }

    // 1b / 2b. SPRITE GEAR (v5 / krea2) - same anchors and swing timing as the procedural
    // rig above, but blits the generated weapon & shield sprites instead of bezier shapes.
    // The weapon sprite is generated blade-up with its grip at the bottom, so it rotates
    // cleanly about a pivot near the hand.
    function blitWeaponSprite(c, pivotX, pivotY, angleRad, targetLen) {
      const img = weaponSpriteImg;
      if (!img || !img.complete || !img.naturalWidth) return;
      const h = targetLen;
      const w = h * (img.naturalWidth / img.naturalHeight);
      c.save();
      c.translate(pivotX, pivotY);
      c.rotate(angleRad);
      // Grip sits ~10% up from the bottom edge of the sprite; park that point on the pivot.
      c.drawImage(img, -w / 2, -h * 0.90, w, h);
      c.restore();
    }

    function drawSpriteWeapon(c, attFrame, isMoving, walkBob, shieldProgress) {
      if (attFrame === 0) {
        const hx = rig.swordX;
        const hy = rig.swordY + (isMoving ? walkBob * 0.5 : 0) + (shieldProgress * 4);
        blitWeaponSprite(c, hx, hy, shieldProgress * 0.35, 74);

      } else if (attFrame <= 4) {
        // Wind-up: cocked up and back over the shoulder.
        const prog = attFrame / 4;
        blitWeaponSprite(c, rig.swordX + 6, rig.swordY - 6, -0.5 - prog * 0.5, 74);

      } else if (attFrame <= 9) {
        // Slash: sweep the blade through a downward arc and trail the swipe streak.
        const progress = (attFrame - 5) / 4;
        c.strokeStyle = 'rgba(255, 255, 255, 0.95)'; c.lineWidth = 6;
        c.beginPath(); c.moveTo(rig.swordX + 7, -20); c.quadraticCurveTo(rig.swordX + 15, -85, -35, -95); c.stroke();
        c.strokeStyle = 'rgba(56, 189, 248, 0.85)'; c.lineWidth = 3;
        c.beginPath(); c.moveTo(rig.swordX + 7, -20); c.quadraticCurveTo(rig.swordX + 15, -85, -35, -95); c.stroke();

        const bx = 18 - progress * 34;
        const by = -46 - Math.sin(progress * Math.PI) * 20;
        const angle = -1.0 + progress * 2.4;      // over-the-shoulder -> swept down across body
        blitWeaponSprite(c, bx, by, angle, 78);

      } else if (attFrame <= 13) {
        // Follow-through: blade low and across to the shield side.
        blitWeaponSprite(c, rig.swordX - 20, rig.swordY - 24, 1.5, 74);

      } else {
        // Recover back to rest.
        const progress = (attFrame - 14) / 4;
        const hx = rig.swordX - (1.0 - progress) * 18;
        const hy = rig.swordY - (1.0 - progress) * 20;
        blitWeaponSprite(c, hx, hy, 1.5 * (1.0 - progress), 74);
      }
    }

    function drawSpriteShield(c, shieldProgress) {
      const img = shieldSpriteImg;
      if (!img || !img.complete || !img.naturalWidth) return;
      // Rise from the left flank to a centred high guard as the block builds.
      const sx = rig.shieldX + shieldProgress * (0 - rig.shieldX);
      const sy = rig.shieldY - shieldProgress * 34;
      const size = 40 + shieldProgress * 20;
      const w = size * (img.naturalWidth / img.naturalHeight);
      c.save();
      c.translate(sx, sy);
      c.drawImage(img, -w / 2, -size / 2, w, size);
      if (shieldProgress > 0.3) {
        c.strokeStyle = `rgba(56, 189, 248, ${shieldProgress * 0.9})`;
        c.lineWidth = 4;
        c.beginPath(); c.arc(0, 0, w / 2 + 6, 0, Math.PI * 2); c.stroke();
      }
      c.restore();
    }

    // Measured opaque bounds of a generated sprite frame, as fractions of the frame, cached per
    // <img>. The krea2 / v4 bundles don't always crop tight - a faint ground-shadow blob or an
    // uneven margin below the feet slips through - which left the multi-frame player hovering in
    // mid-scene instead of standing on the floor. Scanning the real alpha here makes placement
    // independent of how tightly the server trimmed each frame.
    const _spriteTrimCache = new WeakMap();
    let _trimScratch = null;
    function spriteTrimBox(img) {
      const cached = _spriteTrimCache.get(img);
      if (cached !== undefined) return cached;
      const iw = img.naturalWidth, ih = img.naturalHeight;
      if (!_trimScratch) _trimScratch = document.createElement('canvas');
      const cv = _trimScratch;
      // A downscaled pass is plenty to find the bounds and keeps the getImageData scan cheap.
      const scale = Math.min(1, 220 / Math.max(iw, ih));
      const sw = Math.max(1, Math.round(iw * scale));
      const sh = Math.max(1, Math.round(ih * scale));
      cv.width = sw; cv.height = sh;
      const cx = cv.getContext('2d', { willReadFrequently: true });
      cx.clearRect(0, 0, sw, sh);
      cx.drawImage(img, 0, 0, sw, sh);
      let data;
      try { data = cx.getImageData(0, 0, sw, sh).data; }
      catch (e) { _spriteTrimCache.set(img, null); return null; }
      let minX = sw, minY = sh, maxX = -1, maxY = -1;
      for (let y = 0; y < sh; y++) {
        for (let x = 0; x < sw; x++) {
          if (data[(y * sw + x) * 4 + 3] > 14) {   // skip the near-transparent shadow fringe
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      const box = maxX < 0 ? null : {
        x: minX / sw, y: minY / sh,
        w: (maxX - minX + 1) / sw, h: (maxY - minY + 1) / sh,
      };
      _spriteTrimCache.set(img, box);
      return box;
    }

    // Draw a generated character frame so its opaque content is `contentH` px tall and its feet
    // sit at `footY` (origin-relative), horizontally centred on the origin - regardless of the
    // empty margin baked into the frame.
    function drawTrimmedSprite(c, img, footY, contentH) {
      const aspect = img.naturalWidth / img.naturalHeight;
      const box = spriteTrimBox(img);
      if (!box) {
        c.drawImage(img, -(contentH * aspect) / 2, footY - contentH, contentH * aspect, contentH);
        return;
      }
      const fullH = contentH / box.h;
      const fullW = fullH * aspect;
      const contentCX = (box.x + box.w / 2) * fullW;   // opaque centre, from the frame's left
      const contentBottom = (box.y + box.h) * fullH;   // opaque bottom, from the frame's top
      c.drawImage(img, -contentCX, footY - contentBottom, fullW, fullH);
    }

    // Like spriteTrimBox, but with a HARD alpha cut. The enemy sprite is generated small on a
    // white background and background-removed; a faint BiRefNet halo can survive that and, at
    // spriteTrimBox's alpha>14, pass as content - which made the creature read tiny with a big
    // empty margin. alpha>80 pins the box to the solid body so it can be scaled up to fill.
    const _solidBoxCache = new WeakMap();
    function solidContentBox(img) {
      const cached = _solidBoxCache.get(img);
      if (cached !== undefined) return cached;
      const iw = img.naturalWidth, ih = img.naturalHeight;
      if (!iw || !ih) return null;
      if (!_trimScratch) _trimScratch = document.createElement('canvas');
      const cv = _trimScratch;
      const scale = Math.min(1, 220 / Math.max(iw, ih));
      const sw = Math.max(1, Math.round(iw * scale));
      const sh = Math.max(1, Math.round(ih * scale));
      cv.width = sw; cv.height = sh;
      const cx = cv.getContext('2d', { willReadFrequently: true });
      cx.clearRect(0, 0, sw, sh);
      cx.drawImage(img, 0, 0, sw, sh);
      let data;
      try { data = cx.getImageData(0, 0, sw, sh).data; }
      catch (e) { _solidBoxCache.set(img, null); return null; }
      let minX = sw, minY = sh, maxX = -1, maxY = -1;
      for (let y = 0; y < sh; y++) {
        for (let x = 0; x < sw; x++) {
          if (data[(y * sw + x) * 4 + 3] > 80) {
            if (x < minX) minX = x;
            if (x > maxX) maxX = x;
            if (y < minY) minY = y;
            if (y > maxY) maxY = y;
          }
        }
      }
      const box = maxX < 0 ? null : {
        x: minX / sw, y: minY / sh, w: (maxX - minX + 1) / sw, h: (maxY - minY + 1) / sh,
      };
      _solidBoxCache.set(img, box);
      return box;
    }

    // Draw an enemy frame so its SOLID content is `targetH` px tall (but never wider than
    // `maxW`), centred on cx, with the content's bottom edge at bottomY - independent of the
    // empty margin baked into the PNG.
    //
    // Both bounds are needed because the generated sprites now fill their canvas, so their
    // aspect ratios vary enormously with the subject: a RAM stick comes back 141x512 and a
    // dragon with its wingspan 503x187. Sizing on height alone would draw that dragon ~285px
    // wide on a 320px screen.
    // `sizeRef`, when given, is the frame whose measured content decides the scale - pass the
    // idle frame for every frame of a foe so it holds one size while its pose changes. The
    // server crops a foe's frames to a shared box first, so they stay registered and a lunge
    // simply extends past the idle outline instead of rescaling the whole sprite.
    function drawEnemyContent(c, img, cx, bottomY, targetH, maxW, sizeRef) {
      const aspect = img.naturalWidth / img.naturalHeight;
      // Only borrow the reference box when the two frames really are the same canvas - the
      // box is in normalised coordinates, so it means nothing against a different-sized frame
      // (which happens if the server had to crop a regenerated idle on its own).
      const ref = (sizeRef && sizeRef.complete && sizeRef.naturalWidth === img.naturalWidth
                   && sizeRef.naturalHeight === img.naturalHeight) ? sizeRef : img;
      const box = solidContentBox(ref);
      if (!box) {
        let h = targetH, w = targetH * aspect;
        if (maxW && w > maxW) { h *= maxW / w; w = maxW; }
        c.drawImage(img, cx - w / 2, bottomY - h, w, h);
        return;
      }
      // Scale the whole frame so the measured content lands on the target box.
      let fullH = targetH / box.h;
      let fullW = fullH * aspect;
      if (maxW) {
        const contentW = box.w * fullW;
        if (contentW > maxW) { const k = maxW / contentW; fullH *= k; fullW *= k; }
      }
      const contentCX = (box.x + box.w / 2) * fullW;
      const contentBottom = (box.y + box.h) * fullH;
      c.drawImage(img, cx - contentCX, bottomY - contentBottom, fullW, fullH);
    }

    // ---- EXHAUSTION LOOK -------------------------------------------------------------
    // Two cosmetic passes shared by every player render path. Both take `spent` (0..1, the
    // smoothed combatState.exhaustion) and both no-op at zero, so the fresh hero pays nothing
    // for them beyond a comparison.

    // Drain the colour out of the sprite. A hero with an empty bar goes grey and dim rather
    // than being tinted some new colour, because the frames are generated art in an unknown
    // palette - washing out what is there survives any of them, where a wash of red or green
    // would fight half the characters the generator produces. Set as a canvas filter so it
    // costs one state change rather than a per-pixel pass; the callers clear it afterwards.
    function applyExhaustionWash(c, spent) {
      if (spent <= 0.05) return;
      c.filter = 'saturate(' + (1 - spent * 0.6).toFixed(2) + ') ' +
                 'brightness(' + (1 - spent * 0.3).toFixed(2) + ')';
    }

    // Sweat. Three beads on their own staggered falls near the head, each fading as it drops,
    // so it reads as running sweat rather than three dots blinking in unison. `headY` is where
    // the top of the drawn character sits in the caller's already-translated space.
    function drawExhaustionFx(c, spent, headY) {
      if (spent < 0.25) return;
      const t = Date.now();
      const base = Math.min(1, (spent - 0.25) / 0.3) * 0.8;
      c.save();
      c.fillStyle = '#bae6fd';
      for (let i = 0; i < 3; i++) {
        const prog = ((t + i * 310) % 880) / 880;
        c.globalAlpha = base * (1 - prog);
        c.beginPath();
        c.ellipse((i - 1) * 12 + (i === 1 ? 6 : 0), headY + 14 + prog * 30, 1.5, 2.6, 0, 0, Math.PI * 2);
        c.fill();
      }
      c.restore();
    }

        // 3. COMPOSITE OVER-THE-SHOULDER PLAYER RENDERER (VALBRACE PROPORTIONS)
    function drawOverTheShoulderPlayer(c, width, height) {
      if (!combatState.inBattle) return;

      const px = width / 2 + combatState.playerX;
      const isMoving = Math.abs(combatState.vx) > 0.5;
      // The victory leap: once every foe is down and the win banked a level, the hero springs
      // straight up and down on the spot - the mirror of the enemy's winner's dance over a
      // downed player in drawCombatEnemy.
      const joyLeap = combatState.winTick > 0 && combatState.winIsLevelUp;
      // How spent the hero is drawn as, 0..1. Zeroed while dead - the corpse has its own pose
      // and should not also be panting - and while celebrating a win.
      const spent = (combatState.dead || combatState.winTick > 0) ? 0 : combatState.exhaustion;
      // Bob only while actually strafing. The old idle bob ran constantly and, on a sprite with no
      // feet planted animation, read as the character hovering rather than breathing.
      //
      // Running out of stamina CROSSFADES that quick strafe bob into a slow, deep heave that
      // runs whether or not the feet are moving. Crossfaded rather than added, because the
      // point is that a gassed hero stops looking springy: the +1.4 bias sits them lower in
      // frame than their fresh stance, and at 260ms a cycle the breathing is less than a third
      // the rate of the stride. This is what keeps a spent hero looking spent while strafing.
      const walkBase = isMoving ? Math.sin(Date.now() / 90) * 3 : 0;
      const pant = Math.sin(Date.now() / 260) * 2.6 + 1.4;
      const walkBob = walkBase * (1 - spent * 0.7) + pant * spent;
      // Battle entrance: the hero rises into frame from below the canvas. Eased out, so they
      // arrive decelerating into their stance instead of snapping to a stop.
      const slideT = Math.min(1, combatState.introFrame / INTRO_SLIDE_FRAMES);
      const slideIn = Math.pow(1 - slideT, 3) * INTRO_SLIDE_DIST;   // ease-out on the remaining gap
      // abs(sin) so the leap only ever springs the hero off the floor and drops them back, the
      // same shape (and rate) as the enemy's victoryHop - negative is up the canvas.
      const joyHop = joyLeap ? -Math.abs(Math.sin(Date.now() / 130)) * 26 : 0;
      const py = height + walkBob + slideIn + joyHop;

      const attFrame = combatState.attackFrame;
      const hurtFrame = combatState.hurtFrame;
      const shieldProgress = combatState.shieldProgress;

      // v5 (krea2) supplies its own weapon & shield sprites; every other single-sprite mode
      // falls back to the procedural bezier rig. gearWeapon/gearShield are drop-in for the
      // drawModular* pair below.
      const useSpriteGear = activeMode === 'v5_krea' && weaponSpriteImg && weaponSpriteImg.complete && weaponSpriteImg.naturalWidth > 0;
      const gearWeapon = useSpriteGear ? drawSpriteWeapon : drawModularWeapon;
      const gearShield = (useSpriteGear && shieldSpriteImg && shieldSpriteImg.complete && shieldSpriteImg.naturalWidth > 0)
        ? drawSpriteShield : drawModularShield;

      if (hurtFrame > 0) {
        c.fillStyle = 'rgba(239, 68, 68, 0.35)';
        c.fillRect(0, 0, width, height);
      }

      c.save();
      // Spent: hunch forward and sway. The lean is a constant ~4 degrees at full exhaustion and
      // the sway a slow drift on top of it, so the hero looks like they are struggling to hold
      // the stance rather than standing at attention with an empty bar.
      const tilt = combatState.vx * 0.012
                 + spent * (0.075 + Math.sin(Date.now() / 430) * 0.035)
                 + (joyLeap ? Math.sin(Date.now() / 95) * 0.06 : 0);   // celebratory rock
      c.translate(px, py + spent * 4);
      c.rotate(tilt);
      // Mirrored for walking left. After the rotate, so the lean into the strafe stays a lean
      // the way they are going; before everything else, so the sprite frames, the procedural
      // rig's sword and shield, the sweat and the death keel-over all turn round together.
      if (combatState.playerFacing < 0) c.scale(-1, 1);

      // Death pose: keel the whole rig over 90 degrees so the character reads as face-down on
      // the ground. Applied at the shared save/translate so every render path below (sprite
      // sheet, single sprite, procedural rig) tips over together. The translate nudges the
      // now-horizontal body back onto the floor line instead of leaving it pivoted in the air.
      if (combatState.dead) {
        c.rotate(Math.PI / 2);
        c.translate(-18, 46);
      }

      // --- MULTI-FRAME AI SPRITE SHEET MODE (v4: 5 frames / v6: 7-frame swing) ---
      if (playerSpriteFrames && playerSpriteFrames.length > 1) {
        const v6Frames = playerSpriteFrames.length >= 7;
        // The two walk-cycle frames (7, 8) only exist on bundles generated after they were
        // added; an older 7-frame v6 bundle keeps its standing idle while strafing.
        const haveWalk = playerSpriteFrames.length >= 9;
        let currentFrame = playerSpriteFrames[0];
        if (hurtFrame > 0) {
          // v6: idle, block, windup, slash1, slash2, slash3, hurt -> hurt is frame 6.
          currentFrame = playerSpriteFrames[v6Frames ? 6 : 4] || playerSpriteFrames[0];
        } else if (attFrame > 0) {
          const prog = (combatState.attackFrame - 1) / combatState.maxAttackFrames;
          if (v6Frames) {
            // windup + three swing frames spread across the attack
            const swing = [2, 3, 4, 5];
            const k = Math.min(3, Math.max(0, Math.floor(prog * 4)));
            currentFrame = playerSpriteFrames[swing[k]] || playerSpriteFrames[0];
          } else if (prog < 0.45) {
            currentFrame = playerSpriteFrames[2] || playerSpriteFrames[0];
          } else {
            currentFrame = playerSpriteFrames[3] || playerSpriteFrames[0];
          }
        } else if (shieldProgress > 0.3) {
          currentFrame = playerSpriteFrames[1] || playerSpriteFrames[0];
        } else if (haveWalk && isMoving) {
          // Frames 7 and 8 are opposite phases of one stride, alternated in phase with the
          // existing walk bob so the foot-plant and the bob agree. They are NOT a left-step
          // and a right-step: krea2 would not reliably draw one versus the other (see
          // V6_WALK_FRAME_INDICES in server.py), and the direction of travel already reads
          // from the character sliding across the screen.
          currentFrame = playerSpriteFrames[Math.sin(Date.now() / 90) >= 0 ? 7 : 8]
                         || playerSpriteFrames[0];
        }

        if (currentFrame && currentFrame.complete && currentFrame.naturalWidth > 0) {
          // A side-step is ONE frame per direction, not a cycle, so it would otherwise sit
          // perfectly still while the player strafes. The existing walk bob supplies the
          // missing up-down; the pose frame supplies the stride.
          if (haveWalk && isMoving && attFrame <= 0 && hurtFrame <= 0) c.translate(0, walkBob * 0.6);
          // Size the character by its measured opaque height and plant its feet just past the
          // bottom edge, so a loose frame crop or a faint ground-shadow blob can't leave the
          // sprite floating in mid-scene. py is already the canvas bottom, so footY is +18.
          applyExhaustionWash(c, spent);
          drawTrimmedSprite(c, currentFrame, 12, Math.round(height * 0.6));
          c.filter = 'none';
          drawExhaustionFx(c, spent, 12 - Math.round(height * 0.6));
        }
        c.restore();
        return;
      }

      // --- HURT RECOIL WITH FACE TURN TO CAMERA ---
      if (hurtFrame > 0 && hurtFrame <= 14) {
        c.translate((Math.random() * 6 - 3), -6);
        c.fillStyle = '#b45309';
        c.beginPath();
        c.moveTo(-22, 0); c.lineTo(-26, -42); c.lineTo(26, -42); c.lineTo(22, 0);
        c.closePath(); c.fill();
        c.fillStyle = '#fed7aa';
        c.beginPath(); c.arc(-3, -54, 14, 0, Math.PI * 2); c.fill();
        c.strokeStyle = '#7c2d12'; c.lineWidth = 1; c.stroke();
        c.strokeStyle = '#18181b'; c.lineWidth = 1.5;
        c.strokeRect(-10, -58, 7, 6);
        c.strokeRect(-1, -58, 7, 6);
        gearShield(c, 0);
        gearWeapon(c, 0, false, 0, 0);
        c.restore();
        return;
      }

      // =========================================================================
      // LAYER 1: WEAPONS (BEHIND Body in 2D order, deeper in 3D scene)
      // =========================================================================
      if (shieldProgress <= 0.3) {
        gearShield(c, shieldProgress);
      }

      // Neutral sword drawn BEHIND the player so the player's arm overlaps the hilt
      if (attFrame === 0) {
        gearWeapon(c, attFrame, isMoving, walkBob, shieldProgress);
      }

      // =========================================================================
      // LAYER 2: CHARACTER BODY (Foreground layer - overlaps shield & neutral sword)
      // =========================================================================
      if (playerSpriteImg && playerSpriteImg.complete && playerSpriteImg.naturalWidth > 0) {
        const spriteH = 135;
        const spriteW = spriteH * (playerSpriteImg.naturalWidth / playerSpriteImg.naturalHeight);
        rig.shieldX = (-spriteW / 2) + 5;
        rig.swordX = (spriteW / 2) - 5;
        // One-sprite modes have no beaten-up pose to swap to, so the wash and the sweat are
        // the whole of their exhaustion tell - alongside the hunch and heave above, which
        // every render path shares.
        applyExhaustionWash(c, spent);
        c.drawImage(playerSpriteImg, -spriteW / 2, -spriteH + 12, spriteW, spriteH);
        c.filter = 'none';
        drawExhaustionFx(c, spent, 12 - spriteH);
      } else {
        rig.shieldX = -28;
        rig.swordX = 24;
        const gradTorso = c.createLinearGradient(-22, -45, 22, 0);
        gradTorso.addColorStop(0, '#b45309');
        gradTorso.addColorStop(0.5, '#d97706');
        gradTorso.addColorStop(1, '#78350f');
        c.fillStyle = gradTorso;
        c.beginPath();
        c.moveTo(-22, 0); c.lineTo(-26, -46); c.lineTo(26, -46); c.lineTo(22, 0);
        c.closePath(); c.fill();
        c.strokeStyle = '#451a03'; c.lineWidth = 1.5; c.stroke();
        c.fillStyle = '#fed7aa';
        c.beginPath(); c.arc(0, -58, 14, 0, Math.PI * 2); c.fill();
        c.strokeStyle = '#7c2d12'; c.lineWidth = 1; c.stroke();
      }

      // =========================================================================
      // LAYER 3: RAISED SHIELD & ACTIVE SWORD SWING (Overlaying character body)
      // =========================================================================
      if (shieldProgress > 0.3) {
        gearShield(c, shieldProgress);
      }

      // When actively swinging the sword, it sweeps across the foreground
      if (attFrame > 0) {
        gearWeapon(c, attFrame, isMoving, walkBob, shieldProgress);
      }
      
      c.restore();
    }

    // ==========================================
    // DITHERED FADES (ordered 4x4 Bayer)
    // ==========================================
    // A straight globalAlpha fade turns a sprite into a ghost - it goes translucent and you see
    // the corridor through it. What the enemies want instead is the 8-bit dissolve: every pixel
    // stays fully opaque, and the SET of pixels drawn grows (materialising) or shrinks (dying)
    // through an ordered dither. That can't be done with alpha, so it is done by punching holes:
    // draw the sprite into an offscreen canvas at 1:1 with the 320x240 view, erase a Bayer
    // pattern of pixels out of it with destination-out, then blit the result over the scene.
    //
    // 17 patterns are pre-built (0..16 of the 4x4 matrix's cells kept) and cached, so a fade
    // costs one fillRect per frame rather than any per-pixel work.
    const BAYER4 = [
      [0, 8, 2, 10],
      [12, 4, 14, 6],
      [3, 11, 1, 9],
      [15, 7, 13, 5],
    ];
    let _fxCanvas = null, _fxC = null;
    const _ditherPatterns = new Array(17).fill(null);

    // Clear and hand back the offscreen scratch view, sized exactly like the viewport so
    // anything drawn into it lands on the same pixel when blitted back.
    // `dirty`, when given, is the box the caller is about to draw inside - everything the
    // layer touches this cycle. It is a promise, not a clip: the clear, the shade, the dissolve
    // and the final blit all shrink to it, so anything drawn outside it is silently lost.
    //
    // Worth passing wherever it is known, because every one of those four steps is otherwise a
    // full 320x240 canvas operation, and a caller in a loop pays for all four per iteration -
    // drawWorldEnemies puts a whole corridor of foes through here every single frame. A marker
    // twenty pixels wide was costing four screen-sized composites.
    let _fxX = 0, _fxY = 0, _fxW = 0, _fxH = 0;
    function fxLayer(dirty) {
      if (!_fxCanvas) {
        _fxCanvas = document.createElement('canvas');
        _fxCanvas.width = screenWidth;
        _fxCanvas.height = screenHeight;
        _fxC = _fxCanvas.getContext('2d');
      }
      if (dirty) {
        _fxX = Math.max(0, Math.floor(dirty.x));
        _fxY = Math.max(0, Math.floor(dirty.y));
        _fxW = Math.min(screenWidth, Math.ceil(dirty.x + dirty.w)) - _fxX;
        _fxH = Math.min(screenHeight, Math.ceil(dirty.y + dirty.h)) - _fxY;
        if (_fxW < 0) _fxW = 0;
        if (_fxH < 0) _fxH = 0;
      } else {
        _fxX = 0; _fxY = 0; _fxW = screenWidth; _fxH = screenHeight;
      }
      _fxC.setTransform(1, 0, 0, 1, 0, 0);
      _fxC.globalAlpha = 1;
      _fxC.globalCompositeOperation = 'source-over';
      _fxC.filter = 'none';   // the hero's dither-out routes its exhaustion-wash filter through here
      _fxC.clearRect(_fxX, _fxY, _fxW, _fxH);
      return _fxC;
    }

    // Pattern of the pixels to ERASE for a fade that keeps `keep` (0..1) of them.
    function ditherErasePattern(keep) {
      const level = Math.max(0, Math.min(16, Math.round(keep * 16)));
      if (!_ditherPatterns[level]) {
        const tile = document.createElement('canvas');
        tile.width = 4; tile.height = 4;
        const tc = tile.getContext('2d');
        tc.fillStyle = '#000';
        for (let y = 0; y < 4; y++) {
          for (let x = 0; x < 4; x++) {
            // Cells whose threshold is at or above the kept count get erased.
            if (BAYER4[y][x] >= level) tc.fillRect(x, y, 1, 1);
          }
        }
        _ditherPatterns[level] = _fxC.createPattern(tile, 'repeat');
      }
      return _ditherPatterns[level];
    }

    // Finish an fxLayer(): darken it to `shade`, dissolve it to `keep`, blit it to `c`.
    // Both effects are clipped to what was actually drawn (source-atop / destination-out), so
    // the empty rest of the scratch canvas stays empty and the scene shows through it.
    function blitFxLayer(c, keep = 1, shade = 1) {
      if (keep <= 0 || _fxW <= 0 || _fxH <= 0) return;
      // Both fills below cover the layer's dirty box, and a pattern fill is laid down in the
      // CURRENT transform - so reset it, whatever the caller was drawing with. Resetting also
      // keeps the dither pattern anchored to the canvas origin rather than to the box, so a
      // partial fill lands on the same 4x4 phase a full-canvas one would have.
      _fxC.setTransform(1, 0, 0, 1, 0, 0);
      _fxC.globalAlpha = 1;
      if (shade < 1) {
        _fxC.globalCompositeOperation = 'source-atop';
        _fxC.fillStyle = `rgba(0,0,0,${(1 - shade).toFixed(3)})`;
        _fxC.fillRect(_fxX, _fxY, _fxW, _fxH);
      }
      if (keep < 1) {
        _fxC.globalCompositeOperation = 'destination-out';
        _fxC.fillStyle = ditherErasePattern(keep);
        _fxC.fillRect(_fxX, _fxY, _fxW, _fxH);
      }
      _fxC.globalCompositeOperation = 'source-over';
      c.drawImage(_fxCanvas, _fxX, _fxY, _fxW, _fxH, _fxX, _fxY, _fxW, _fxH);
    }

    // ==========================================
    // WORLD ENEMY MARKERS (exploration view)
    // ==========================================
    // The floating foe you walk into to start a fight. Camera-facing billboards, drawn after
    // the raycast has been flushed to the canvas so they can be real drawImage() calls (the
    // sprites are Images, not ImageData) - which means occlusion has to be re-done by hand:
    // each marker is clipped to the runs of screen columns where it is nearer than the wall
    // the raycaster already recorded in zBuffer.
    const MARKER_HEIGHT_FRAC = 0.46;   // of the wall height at the marker's distance
    const MARKER_WIDTH_FRAC = 0.62;
    const MARKER_HOVER_FRAC = 0.24;    // lifted off the floor line by this much of a wall
    // A marker is drawn at its own variant's proportions relative to the walker, so the corridor
    // tells the player what is waiting before they step into it: a dread boss looms half again
    // as large, and a flyer hangs higher up the passage.
    function markerScaleFor(variant) {
      const cfg = ENEMY_VARIANTS[variant] || ENEMY_VARIANTS.walker;
      return {
        size: cfg.heightFrac / ENEMY_VARIANTS.walker.heightFrac,
        // cfg.hover is in combat-canvas pixels (0..240); as a fraction of a wall it reads the
        // same at any distance.
        lift: (cfg.hover || 0) / screenHeight,
      };
    }
    function drawWorldEnemies(c, posX, posY, dirX, dirY, planeX, planeY) {
      if (!enemyMarkers.length) return;
      const invDet = 1.0 / (planeX * dirY - dirX * planeY);

      const visible = [];
      for (const m of enemyMarkers) {
        if (!m.alive) continue;
        const relX = (m.x + 0.5) - posX;
        const relY = (m.y + 0.5) - posY;
        const tX = invDet * (dirY * relX - dirX * relY);
        const tY = invDet * (-planeY * relX + planeX * relY);
        if (tY < 0.28) continue;                    // behind the camera or inside it
        visible.push({ m, tX, tY });
      }
      if (!visible.length) return;
      visible.sort((a, b) => b.tY - a.tY);          // far to near, so nearer foes overlap

      for (const v of visible) {
        const wallH = (screenHeight * WALL_HEIGHT) / v.tY;
        const screenX = (screenWidth / 2) * (1 + v.tX / v.tY);
        const floorY = screenHeight / 2 + wallH / 2;
        const scale = markerScaleFor(v.m.variant);
        // A flyer bobs faster and further than something standing on the floor.
        const bobRate = scale.lift > 0 ? 260 : 430;
        const bob = Math.sin(Date.now() / bobRate + v.m.phase) * (wallH * (scale.lift > 0 ? 0.055 : 0.035));
        const bottomY = floorY - wallH * (MARKER_HOVER_FRAC + scale.lift) + bob;

        const img = markerFrameFor(v.m.variant);
        const targetH = wallH * MARKER_HEIGHT_FRAC * scale.size;
        const maxW = wallH * MARKER_WIDTH_FRAC * scale.size;
        let drawW, drawH, drawX, drawY;
        if (img) {
          const box = solidContentBox(img);
          const aspect = img.naturalWidth / img.naturalHeight;
          drawH = targetH;
          drawW = drawH * aspect;
          if (box) {
            // Same content-box sizing the battle view uses, so a sprite with a big transparent
            // margin isn't drawn as a thumbnail floating in an invisible box.
            let fullH = drawH / box.h;
            let fullW = fullH * aspect;
            if (box.w * fullW > maxW) { const k = maxW / (box.w * fullW); fullH *= k; fullW *= k; }
            drawW = fullW; drawH = fullH;
            drawX = screenX - (box.x + box.w / 2) * fullW;
            drawY = bottomY - (box.y + box.h) * fullH;
          } else {
            if (drawW > maxW) { drawH *= maxW / drawW; drawW = maxW; }
            drawX = screenX - drawW / 2;
            drawY = bottomY - drawH;
          }
        } else {
          drawH = targetH;
          drawW = drawH;
          drawX = screenX - drawW / 2;
          drawY = bottomY - drawH;
        }

        // A pack marker shows the pack: the same sprite drawn `group` times, spread along the
        // corridor and each bobbing on its own phase so it reads as several small foes rather
        // than one blurred silhouette. Offsets are fractions of the drawn width, so the spread
        // holds at any distance.
        const groupN = Math.max(1, (ENEMY_VARIANTS[v.m.variant] || {}).group || 1);
        const members = [];
        for (let i = 0; i < groupN; i++) {
          members.push({
            dx: groupN === 1 ? 0 : (i - (groupN - 1) / 2) * drawW * 0.60,
            dy: groupN === 1 ? 0 : Math.sin(Date.now() / bobRate + v.m.phase + i * 1.9) * wallH * 0.02,
          });
        }
        const spread = members.reduce((m, k) => Math.max(m, Math.abs(k.dx)), 0);
        const wobble = members.reduce((m, k) => Math.max(m, Math.abs(k.dy)), 0);

        // Cheap reject before the per-column occlusion scan.
        const spanL = Math.floor(Math.min(drawX, screenX - drawW / 2) - spread);
        const spanR = Math.ceil(Math.max(drawX + drawW, screenX + drawW / 2) + spread);
        if (spanR < 0 || spanL >= screenWidth) continue;

        // Walk the sprite's columns and collect the unoccluded runs. Clipping to those rects
        // is what lets a marker be half-hidden behind a corner instead of popping into view
        // whole the moment its centre clears the wall.
        c.save();
        c.beginPath();
        let runStart = -1, runs = 0;
        // The band has to reach the floor line as well as the sprite: the marker hovers, so its
        // ground shadow sits well below its own bottom edge and would be clipped off otherwise.
        const clipTop = Math.max(0, Math.floor(Math.min(drawY - wobble, floorY)) - 2);
        const clipBottom = Math.min(screenHeight, Math.ceil(Math.max(drawY + drawH + wobble, floorY + wallH * 0.06)) + 2);
        const clipH = Math.max(1, clipBottom - clipTop);
        for (let x = Math.max(0, spanL); x <= Math.min(screenWidth - 1, spanR); x++) {
          const open = v.tY < zBuffer[x];
          if (open && runStart < 0) runStart = x;
          else if (!open && runStart >= 0) { c.rect(runStart, clipTop, x - runStart, clipH); runs++; runStart = -1; }
        }
        if (runStart >= 0) { c.rect(runStart, clipTop, Math.min(screenWidth, spanR + 1) - runStart, clipH); runs++; }
        if (!runs) { c.restore(); continue; }
        c.clip();

        // Distance shading matched to the wall pass, so a marker down a long corridor sinks
        // into the same gloom the stonework does. Floored higher than a wall's, because these
        // read as lit from within.
        const shade = Math.max(0.45, 1.0 / (1.0 + v.tY * 0.30));

        // The clip band above is already the exact extent of everything drawn below - sprite,
        // spread, wobble and ground shadow - so handing it to the layer as its dirty box cannot
        // change a visible pixel, and it turns four full-canvas composites per marker into four
        // small ones.
        const clipL = Math.max(0, spanL);
        const f = fxLayer({ x: clipL, y: clipTop, w: Math.min(screenWidth, spanR + 1) - clipL, h: clipH });
        // Ground shadows first, so they are shaded and clipped with the bodies.
        f.fillStyle = 'rgba(0,0,0,0.34)';
        for (const k of members) {
          f.beginPath();
          f.ellipse(screenX + k.dx, floorY - wallH * 0.02, drawW * 0.22, wallH * 0.035, 0, 0, Math.PI * 2);
          f.fill();
        }

        if (img) {
          for (const k of members) f.drawImage(img, drawX + k.dx, drawY + k.dy, drawW, drawH);
        } else {
          // No generated sprite (v1 video mode, or a bundle whose enemy failed): a plain
          // hovering sigil still tells the player a fight is parked on this tile.
          const r = drawW / 2;
          const cx = screenX, cy = bottomY - r;
          const g = f.createRadialGradient(cx, cy, r * 0.1, cx, cy, r);
          g.addColorStop(0, '#f87171');
          g.addColorStop(0.6, '#7f1d1d');
          g.addColorStop(1, 'rgba(24,0,0,0)');
          f.fillStyle = g;
          f.beginPath(); f.arc(cx, cy, r, 0, Math.PI * 2); f.fill();
          f.fillStyle = '#fde047';
          f.fillRect(cx - r * 0.45, cy - r * 0.15, r * 0.3, r * 0.14);
          f.fillRect(cx + r * 0.15, cy - r * 0.15, r * 0.3, r * 0.14);
        }
        blitFxLayer(c, 1, shade);
        c.restore();
      }
    }

    // High-Detail Shaded Dark Fantasy Demon Knight Enemy
    // The foe, its entrance and its dissolve. The body is drawn through an offscreen layer
    // whenever it is part-way through a fade, so the dither can punch holes in the finished
    // figure rather than in each shape it is built from - see blitFxLayer. The name plate is
    // never dithered: it belongs to the HUD, and it stays up through the dissolve so the kill
    // reads as a kill.
    function drawCombatEnemy(c, width, height) {
      if (!combatState.inBattle) return;

      // Back to front: whatever is highest up the arena is laid down first, so anything nearer
      // the camera overlaps it. Both things that push a foe up the canvas count - altitude (a
      // flyer's hover) and depth (a boss withdrawn for its charge) - weighted so a fully
      // withdrawn foe sorts behind anything merely airborne. Sorted on a copy: the array order
      // is the pack order everywhere else (formOffset, orbit phase) and must not move.
      const order = combatState.enemies
        .filter(e => e.hp > 0 || e.deathFade > 0 || e.endingHold)
        .slice()
        .sort((a, b) => ((b.altitude || 0) + (b.depth || 0) * 120)
                      - ((a.altitude || 0) + (a.depth || 0) * 120));

      for (const e of order) {
        // Each foe carries its own dissolve, so in a pack one corpse dithers away while the
        // rest are still solid - which means the fade layer is per foe, not per frame.
        const fade = enemyVisibility(e);
        if (fade <= 0) continue;
        if (fade < 1) {
          drawEnemyBody(fxLayer(), width, height, e);
          blitFxLayer(c, fade, 1);
        } else {
          drawEnemyBody(c, width, height, e);
        }
      }
      // The plate waits for the foe to start materialising rather than announcing a creature
      // that isn't on screen yet - but it stays up through the dissolve, so the emptied health
      // bar is the last thing seen of it. That is exactly the window enemyVisibility opens at,
      // and it has to be read off the clock rather than off the lead: in a pack the lead can
      // be the first one down, and the plate belongs to the whole pack.
      // ...but it comes down the instant the pack's own dissolve is over and the hero's outro
      // begins: by then the corpse has been gone for the full DEATH_FADE_HOLD and the frame
      // belongs to the winner.
      if (combatState.introFrame > INTRO_FADE_DELAY && combatState.winTick === 0) {
        drawEnemyHpBar(c, width, combatState.enemy);
      }
    }

    // How close is the wall the foe is standing against? The raycaster has already written
    // every column's perpendicular distance into zBuffer for THIS frame, so the answer is just
    // the nearest of the columns the foe's body covers - no second cast, and it accounts for
    // side walls in a tight corridor as readily as for the one being faced.
    function wallDistAt(ex, width) {
      const lo = Math.max(0, Math.round(ex) - 24);
      const hi = Math.min(width - 1, Math.round(ex) + 24);
      let d = Infinity;
      for (let x = lo; x <= hi; x++) if (zBuffer[x] < d) d = zBuffer[x];
      return d;
    }

    // Walk a foe forward out of the wall behind it. GROUND_Y stages the fight on the floor line
    // of a wall ~1.6 cells off; when what is actually ahead is nearer than that, its floor line
    // sits LOWER on the canvas than the foe's feet and the foe reads as standing partway up the
    // masonry rather than in front of it. So: drop the feet to just past that line and grow the
    // foe by the perspective factor the move implies, capped so it stays framed. The line is
    // only ever moved DOWN - in open floor `push` is zero and the staging is untouched, exactly
    // as it was. Returns the feet line to draw on and the size multiplier that goes with it.
    //
    // The push is eased on the foe itself rather than taken cold each frame: the sampled wall
    // distance steps as the hero turns past a corner, and an un-eased foe would jump size with
    // it. It also means a foe already pulled in relaxes back out over a few frames when the
    // hero steps away from the wall.
    function nearWallStaging(e, cfg, sampleX, width, height, depthScale, depth) {
      const horizon = height / 2;
      const base = GROUND_Y - depth * DEPTH_LIFT;
      const wallDist = wallDistAt(sampleX, width);
      // Same projection the floor/ceiling caster uses, so this lands ON the drawn seam rather
      // than near it: a surface at distance d meets the floor at horizon + (WALL_HEIGHT/2)*h/d.
      const wallFloorY = isFinite(wallDist)
        ? horizon + ((WALL_HEIGHT / 2) * height) / Math.max(0.1, wallDist)
        : GROUND_Y;
      const front = Math.min(NEAR_WALL_GROUND_MAX, wallFloorY + NEAR_WALL_CLEARANCE);
      e.nearPush = (e.nearPush || 0) + (Math.max(0, front - GROUND_Y) - (e.nearPush || 0)) * NEAR_WALL_EASE;
      if (e.nearPush <= 0.5) return { groundY: base, scale: 1, lift: 0 };

      // A flyer rides the pull-in down the canvas with everything else; lift it back up a share
      // of that drop so it still hangs overhead rather than in the hero's face. Grounded foes
      // are meant to come down to eye level, so they get nothing - and the lift fades out with
      // the flyer's own altitude, so a diving swoop still reaches the floor instead of pulling
      // its strike short against a wall.
      const hoverFrac = cfg.hover > 0 ? Math.min(1, (e.altitude || 0) / cfg.hover) : 0;
      const lift = cfg.fly ? e.nearPush * NEAR_WALL_FLY_LIFT * hoverFrac : 0;

      // The front line, eased. DEPTH then rides on top of it - but the room to withdraw into is
      // exactly the room the wall left, so a boss backing off for its charge stops with its feet
      // just short of the seam instead of climbing the wall again. Against a tight wall that
      // makes the withdrawal a short move rather than no move: it still shrinks, and rises as
      // far as there is anything to rise into, and standing hard against the masonry is where
      // it would really be.
      const f = GROUND_Y + e.nearPush;
      // ...and never PAST the front line. With the hero backed into a corner the seam is below
      // the staged feet, wallFloorY - BACK_ROOM comes out under f, and the withdrawal inverts:
      // the boss walks DOWN the canvas and looms larger the further back it is meant to be
      // going. A corner has no room to withdraw into and the honest answer is that it barely
      // moves, so this pins the far end at the front line and lets DEPTH_SHRINK sell the rest.
      const back = Math.min(f, Math.max(wallFloorY - NEAR_WALL_BACK_ROOM, f - DEPTH_LIFT));
      const groundY = f - depth * (f - back);
      // Feet twice as far below the horizon means half the distance, so twice the size. Measured
      // off the FRONT line rather than the drawn feet, so this is purely the near-wall part -
      // the caller still multiplies by DEPTH_SHRINK's own factor. Measuring it off `groundY`
      // counted the withdrawal twice: the depth lift had already pulled the feet towards the
      // horizon, so the ratio shrank the boss again on top of the shrink it had just been
      // given, and a charge staged against a wall wound up at under half the size the same
      // charge reaches in open floor - small and far off rather than backed up and looming.
      let scale = (f - horizon) / (GROUND_Y - horizon);
      // Damped for everything but the boss - see NEAR_WALL_SCALE_DAMP.
      if (e.variant !== 'boss') scale = 1 + (scale - 1) * NEAR_WALL_SCALE_DAMP;
      // ...but never past the cap, and never taller than the canvas above its own feet: a boss
      // is two thirds of the view before any of this, and a flyer's bottom edge is its hover
      // height up from the ground it just moved.
      const baseH = height * cfg.heightFrac * depthScale;
      const bottomY = groundY - (e.altitude || 0) - lift;
      scale = Math.min(scale, NEAR_WALL_SCALE_MAX, (bottomY - NEAR_WALL_HEAD_ROOM) / baseH);
      return { groundY, scale, lift };
    }

    function drawEnemyBody(c, width, height, which) {
      const e = which || combatState.enemy;
      const cfg = ENEMY_VARIANTS[e.variant] || ENEMY_VARIANTS.walker;
      // DEPTH. 0 is the front line, where every fight is normally fought; 1 is the back of the
      // arena, where the boss withdraws for its charge. There is no real third axis in this
      // view, so distance is sold the two ways a flat scene can sell it: the figure shrinks,
      // and its feet ride up towards the horizon. Its x offset is pulled in by the same factor,
      // so backing off narrows the whole arena the way perspective would - a weave that covers
      // 148px of arena reads as a shorter, faster sweep across the back wall.
      const depth = e.depth || 0;
      const depthScale = 1 - DEPTH_SHRINK * depth;
      const ex = width / 2 + (e.x || 0) * depthScale;
      // Only DEPTH scales the arena's width. The near-wall pull-in below deliberately doesn't:
      // widening a pack by the same factor it grows them by would push the outermost of three
      // runts (x reaches +/-92) clean off a 320px canvas at exactly the moment they are meant
      // to be in the hero's face.
      // Which column the pull-in samples the wall at. Its own, for anything holding ground -
      // but NOT during the withdrawn phases of the boss's charge. The weave crosses the arena
      // at BOSS_WEAVE_SPEED, and a per-column sample means the staging chases whatever geometry
      // happens to slide under it: sweep off a near wall and past a doorway and the pull-in
      // drops out mid-sweep, so the boss shrinks and its feet jump up the canvas as if it had
      // bolted across the room, then snaps back on the return leg. It pumps twice a lap. So
      // these phases sample straight ahead instead - the column the duel is staged on, and the
      // one the weave is centred on - which still tracks the hero walking into a wall while the
      // boss's own sweep no longer touches it. The rush is left on its real column: it is
      // coming back to the front line and the arrival should be staged where it lands.
      const sampleX = (e.special && e.special !== 'none' && e.special !== 'rush') ? width / 2 : ex;
      const near = nearWallStaging(e, cfg, sampleX, width, height, depthScale, depth);
      const dScale = depthScale * near.scale;
      const groundY = near.groundY;
      // Near-wall flyer lift (see NEAR_WALL_FLY_LIFT) - folded into altitude everywhere the foe's
      // hover height is read, so the sprite, its shadow fade and the procedural body all rise
      // together. Zero for grounded foes and whenever the pull-in isn't active.
      const altLift = near.lift || 0;
      // The winner's dance: once the player is down, the enemy bounces straight up and down on
      // the spot, celebrating. Negative = higher on the canvas; abs(sin) so it only ever leaves
      // the ground and lands, never sinks through it.
      const victoryHop = combatState.dead ? -Math.abs(Math.sin(Date.now() / 130)) * 24 : 0;
      // Same plate clearance the sprite path applies below, for the procedural fallback body:
      // its horn tips are the highest thing it draws, about 65px above ey. Clamped on the
      // resting height with the bob's swing reserved above it and the bob added back after,
      // for the same reason - see the sprite path.
      const eyBob = Math.sin(Date.now() / 200) * 4;
      let ey = (groundY - 70) - (e.altitude || 0) - altLift + victoryHop;
      const eyCeiling = hpPlateClear() + 65 + 4;
      if (ey < eyCeiling) ey = Math.min(groundY - 70, eyCeiling);
      ey += eyBob;

      // No telegraph circle - the attack frame shows the wind-up, and the "ENEMY WIND-UP!"
      // floating text still calls it.

      // --- AI ENEMY SPRITE (idle / attack / hurt) ---
      // Falls through to the procedural enemy below when no sprites were generated, so an enemy
      // that failed to generate (or a dungeon made before this existed) still has an opponent.
      if (enemySpriteFrames && enemySpriteFrames.length > 0) {
        // Per-variant frame set (idle / attack / block) when the bundle has one; otherwise the
        // legacy flat [idle, attack, hurt] array from v3/v4.
        // Looked up per draw rather than read off the global: a pack foe's set is a recolour
        // built on demand, and the first frames of a fight can land before the sprite it
        // borrows has finished decoding - in which case enemyFramesFor hands back the untinted
        // original and quietly upgrades itself once the source is ready.
        const frames = enemyFramesFor(e.variant) || enemyFrames;
        let frame, sizeRef = null;
        // Last Attack Frame as it applies to THIS foe - Mixed resolves to quick or flip by variant.
        const attackMode = attackFrameModeFor(e);
        if (frames && frames.idle) {
          frame = frames.idle;
          // Attack wins over block: the AI clears blockTimer when it commits to a strike, so
          // these do not overlap in practice, but the strike is the one that must read.
          // The attack frame goes up with the telegraph, well before the blow lands, and
          // Last Attack Frame decides what happens to that gap:
          //   on    - the tick the blow DOES land swaps in the strike frame for the rest of the
          //           attack. A dungeon generated without one (every frame version 1 run) has no
          //           strike frame and simply stays on the attack frame, exactly as before.
          //   quick - the attack frame waits for the blow. The grounded AI no longer telegraphs
          //           at all, but the flyer's dive and the boss's charge run-in are movement and
          //           still happen - so they are drawn in the foe's ordinary stance until the
          //           blow lands on the tick they arrive.
          //   flip  - picks frames exactly as Off does; its difference is the mirror below.
          //   mixed - quick on the ground, except that the boss's charge takes its pose as the
          //           run-in starts; flip in the air. See attackPoseUp.
          const landed = e.state === 'attack' && e.strikeLanded;
          if (landed && attackMode === 'on' && frames.strike) frame = frames.strike;
          else if (attackPoseUp(e, attackMode)) frame = frames.attack || frame;
          else if (e.blockTimer > 0) frame = frames.block || frame;
          // Scale EVERY frame by the idle's content box. Sizing each frame on its own box
          // would shrink the whole foe whenever it lunged, since a thrust-out limb measures
          // bigger; anchoring on the idle keeps it a constant size and lets the attack frame
          // genuinely reach further than the idle silhouette.
          sizeRef = frames.idle;
        } else {
          frame = enemySpriteFrames[0];
          if (e.state === 'hurt') frame = enemySpriteFrames[2] || frame;
          else if (attackPoseUp(e, attackMode)) frame = enemySpriteFrames[1] || frame;
        }

        if (frame && frame.complete && frame.naturalWidth > 0) {
          // Size by MEASURED solid content, not the raw frame - a small generation still fills
          // the combat view. heightFrac is per-variant: boss looms, flyer is smaller & airborne.
          let targetH = Math.round(height * cfg.heightFrac * dScale);
          let maxW = Math.round(width * (cfg.widthFrac || 0.7) * dScale);
          const bobAmp = cfg.fly ? 4 : 3;
          const bob = Math.sin(Date.now() / (cfg.fly ? 110 : 220)) * bobAmp;
          // Hover, but not behind the name plate. A flyer's whole point is being up out of
          // reach, and at full hover that put its head under the plate - so the foe the player
          // is meant to be reading was a pair of legs. Pushed back DOWN rather than shrunk (it
          // has to stay the same creature it was a frame ago) and never past its own floor
          // line, so a swoop still reaches the ground and a foe too tall to fit - the boss is
          // two thirds of the view - simply stays where it was rather than being lifted.
          //
          // The clamp is applied to the RESTING height with the bob's own swing reserved above
          // it, and the bob then goes back on top. Clamping the already-bobbed value pinned
          // bottomY to a constant, which killed the hover outright: a flyer held under the
          // plate hung there dead still. This way it floats about its held height exactly as
          // it floats about its free one, and the reserved swing keeps the upstroke clear of
          // the plate.
          let bottomY = groundY - (e.altitude || 0) - altLift + victoryHop;
          const ceiling = hpPlateClear() + targetH + bobAmp;
          if (bottomY < ceiling) bottomY = Math.min(groundY, ceiling);
          // ...and if it STILL doesn't fit, shrink it until it does. Pushing down stops at the
          // floor line, so a foe taller than the canvas above its own feet - the boss, at two
          // thirds of the view - kept its full height and wore the name plate across its face.
          // Everything the player reads off a boss is in that face, so the last resort is to
          // take a little height off rather than a little head: scaled just enough that its
          // crown comes to rest against the underside of the plate (with the bob's own swing
          // reserved, so the upstroke touches the plate rather than slipping behind it), and
          // maxW goes with it so the whole figure shrinks instead of squashing. Only bites when
          // the plate is genuinely in the way - a foe that already fits is untouched, and the
          // boss at depth (mid-charge, drawn smaller by dScale) falls back to its own size.
          // Measured off the RESTING feet line: the victory hop lifts 24px and would otherwise
          // pulse the foe smaller and back on every bounce.
          const headRoom = (bottomY - victoryHop) - hpPlateClear() - bobAmp;
          if (headRoom > 0 && targetH > headRoom) {
            const fit = headRoom / targetH;
            targetH = Math.round(targetH * fit);
            maxW = Math.round(maxW * fit);
          }
          bottomY += bob;

          c.save();
          // Ground shadow - fades and shrinks as a flyer climbs, and travels up the canvas with
          // its owner's feet as a withdrawn foe backs away.
          const sh = cfg.fly ? Math.max(0.14, 1 - ((e.altitude || 0) + altLift) / 90) : 1;
          c.fillStyle = `rgba(0,0,0,${0.28 * sh})`;
          c.beginPath();
          c.ellipse(ex, groundY + 3, targetH * 0.32 * sh, targetH * 0.08 * sh, 0, 0, Math.PI * 2);
          c.fill();

          if (e.endingHold) {
            // A beaten boss held for the ending cutscene: the ordinary hurt shake, harder, with the
            // frame flashing red every other beat - it has to read as "that finished it" for the
            // whole wait before the cut, not as one more hit it shrugs off.
            c.translate((Math.random() * 12 - 6), 0);
            if (Math.floor(Date.now() / 110) % 2 === 0) frame = hurtTintFrame(frame);
          } else if (e.state === 'hurt') { c.translate((Math.random() * 8 - 4), 0); c.globalAlpha = 0.9; }
          else if (e.blockTimer > 0) { c.globalAlpha = 0.94; }

          // Mirrored about its own centre line when it is walking the other way. Scoped to the
          // sprite alone - the pip bar below must not come out filling from the right.
          // Last Attack Frame's FLIP mode turns it the other way for the rest of an attack whose
          // blow has landed (landEnemyStrike) - relative to whichever way it already faces, so a
          // foe walking left snaps round to the right - and it turns back as the attack ends.
          // Draw-time only: e.facing is left alone, so the walk-direction logic never sees it.
          const flipped = attackMode === 'flip' && e.state === 'attack' && e.strikeLanded;
          c.save();
          if ((e.facing < 0) !== flipped) { c.translate(ex * 2, 0); c.scale(-1, 1); }
          drawEnemyContent(c, frame, ex, bottomY, targetH, maxW, sizeRef);
          c.restore();
          c.globalAlpha = 1;

          // In a pack the plate at the top of the screen is the pack's total, so each member
          // carries its own thin bar to show which one is actually being worn down. A lone foe
          // has the plate and doesn't need one.
          if (combatState.enemies.length > 1 && e.hp > 0) {
            // Floored below the name plate: a circler at the top of its arc sits high enough
            // that its bar would otherwise land on top of it.
            drawEnemyPipBar(c, ex, Math.max(hpPlateClear(), bottomY - targetH - 10), e);
          }

          // The guard arc and the boss aura that used to be stroked over the sprite here are
          // gone, along with the telegraph circle above. They were standing in for poses the
          // sprites could not show; each foe now has its own generated block and attack frame,
          // so the pose carries it and the shapes on top just obscured the art.
          c.restore();
          return;
        }
      }

      const isHurt = e.state === 'hurt';
      c.save();
      // The procedural knight is drawn at fixed pixel offsets around ey, so the near-wall pull-in
      // has to reach it as a transform. About (ex, groundY), which is where its feet are - the
      // figure grows up out of the floor instead of sliding off it.
      if (near.scale > 1) {
        c.translate(ex, groundY);
        c.scale(near.scale, near.scale);
        c.translate(-ex, -groundY);
      }
      if (isHurt) c.translate((Math.random() * 8 - 4), 0);

      // Spiked Pauldrons
      c.fillStyle = isHurt ? '#7f1d1d' : '#18181b';
      c.beginPath();
      c.moveTo(ex - 15, ey - 10); c.lineTo(ex - 48, ey - 32); c.lineTo(ex - 52, ey - 10); c.lineTo(ex - 20, ey + 15);
      c.closePath(); c.fill();
      c.strokeStyle = '#38bdf8'; c.lineWidth = 1.5; c.stroke();

      c.beginPath();
      c.moveTo(ex + 15, ey - 10); c.lineTo(ex + 48, ey - 32); c.lineTo(ex + 52, ey - 10); c.lineTo(ex + 20, ey + 15);
      c.closePath(); c.fill();
      c.strokeStyle = '#38bdf8'; c.lineWidth = 1.5; c.stroke();

      // Chestplate
      const gradTorso = c.createRadialGradient(ex, ey + 10, 4, ex, ey + 10, 32);
      gradTorso.addColorStop(0, isHurt ? '#ef4444' : '#312e81');
      gradTorso.addColorStop(0.7, isHurt ? '#991b1b' : '#0f172a');
      gradTorso.addColorStop(1, '#020617');
      c.fillStyle = gradTorso;

      c.beginPath();
      c.moveTo(-24 + ex, ey - 12); c.lineTo(24 + ex, ey - 12); c.lineTo(18 + ex, ey + 32); c.lineTo(-18 + ex, ey + 32);
      c.closePath(); c.fill();
      c.strokeStyle = '#475569'; c.lineWidth = 2; c.stroke();

      // Rune
      c.fillStyle = e.state === 'telegraph' ? '#fde047' : '#ef4444';
      c.beginPath();
      c.moveTo(ex, ey - 4); c.lineTo(ex + 8, ey + 8); c.lineTo(ex, ey + 20); c.lineTo(ex - 8, ey + 8);
      c.closePath(); c.fill();

      // Horned Helmet
      const gradHelm = c.createRadialGradient(ex, ey - 22, 2, ex, ey - 22, 20);
      gradHelm.addColorStop(0, '#475569'); gradHelm.addColorStop(0.8, '#0f172a'); gradHelm.addColorStop(1, '#020617');
      c.fillStyle = gradHelm;

      c.beginPath();
      c.moveTo(ex - 18, ey - 12); c.lineTo(ex - 16, ey - 36); c.lineTo(ex, ey - 44); c.lineTo(ex + 16, ey - 36); c.lineTo(ex + 18, ey - 12);
      c.closePath(); c.fill();
      c.strokeStyle = '#1e293b'; c.lineWidth = 2; c.stroke();

      // Horns
      c.fillStyle = '#020617';
      c.beginPath();
      c.moveTo(ex - 14, ey - 32); c.bezierCurveTo(ex - 36, ey - 42, ex - 44, ey - 60, ex - 32, ey - 65); c.bezierCurveTo(ex - 32, ey - 50, ex - 22, ey - 40, ex - 10, ey - 36);
      c.moveTo(ex + 14, ey - 32); c.bezierCurveTo(ex + 36, ey - 42, ex + 44, ey - 60, ex + 32, ey - 65); c.bezierCurveTo(ex + 32, ey - 50, ex + 22, ey - 40, ex + 10, ey - 36);
      c.fill();
      c.strokeStyle = '#dc2626'; c.lineWidth = 1.5; c.stroke();

      // Glowing Eyes
      c.fillStyle = e.state === 'telegraph' ? '#facc15' : '#ef4444';
      c.fillRect(ex - 12, ey - 24, 10, 4);
      c.fillRect(ex + 2, ey - 24, 10, 4);

      c.restore();
    }

    // Pulled out of drawCombatEnemy so the AI-sprite path can draw it too - that path returns
    // early to skip the procedural body, which silently took the name plate with it.
    // Sized to fit the label rather than a fixed width: a long generated name (or a pack's
    // "x3 [hp/maxhp]" suffix) used to run past the edges of a fixed-width bar, so the plate is
    // measured off the actual text and only ever grows to fit it, never the other way round.
    function drawEnemyHpBar(c, width, e) {
      // A pack shares one plate: the bar is the whole pack's remaining HP and the count is how
      // many of them are still standing, so it empties over the fight the way a single foe's
      // does. Which one you are currently cutting into is read off the little bar over its own
      // head - see drawEnemyPipBar.
      const pack = combatState.enemies;
      const isPack = pack.length > 1;
      const hp = isPack ? pack.reduce((s, k) => s + Math.max(0, k.hp), 0) : e.hp;
      const maxHp = isPack ? pack.reduce((s, k) => s + k.maxHp, 0) : e.maxHp;
      const label = isPack
        ? `${e.name || 'NIGHTSTALKER'} x${pack.filter(k => k.hp > 0).length} [${hp}/${maxHp}]`
        : `${e.name || 'NIGHTSTALKER'} [${e.hp}/${e.maxHp}]`;

      c.font = 'bold 11px sans-serif';
      const w = Math.max(132, Math.ceil(c.measureText(label).width) + 18);
      const h = HP_PLATE_H;
      const top = hpPlateTop();

      c.fillStyle = 'rgba(15, 23, 42, 0.9)';
      c.fillRect(width / 2 - w / 2, top, w, h);
      c.strokeStyle = '#94a3b8'; c.lineWidth = 1.5;
      c.strokeRect(width / 2 - w / 2, top, w, h);

      const hpW = Math.max(0, (hp / maxHp) * (w - 4));
      c.fillStyle = '#dc2626';
      c.fillRect(width / 2 - w / 2 + 2, top + 2, hpW, h - 4);

      c.fillStyle = '#f8fafc';
      c.textAlign = 'center';
      c.fillText(label, width / 2, top + h - 5);
    }

    // The thin HP bar a pack member wears over its own head. Deliberately tiny and unlabelled -
    // it is there to say "this is the one you have been hitting", not to be read as a number.
    function drawEnemyPipBar(c, cx, y, e) {
      const w = 30, h = 4;
      c.fillStyle = 'rgba(15, 23, 42, 0.85)';
      c.fillRect(cx - w / 2 - 1, y - 1, w + 2, h + 2);
      c.fillStyle = '#dc2626';
      c.fillRect(cx - w / 2, y, Math.max(0, (e.hp / e.maxHp) * w), h);
      c.strokeStyle = 'rgba(148, 163, 184, 0.75)'; c.lineWidth = 1;
      c.strokeRect(cx - w / 2 - 1.5, y - 1.5, w + 3, h + 3);
    }

    // Floating text ages on the SIMULATION clock, not the render clock - it used to age inside
    // drawCombatEffects, which meant a slow frame stretched the popups along with everything
    // else. Advancing it in combatTick keeps `life: 32` worth ~0.53s no matter the frame rate.
    function updateCombatEffects() {
      for (let i = combatState.combatEffects.length - 1; i >= 0; i--) {
        const eff = combatState.combatEffects[i];
        eff.life--;
        eff.y -= 0.8;
        if (eff.life <= 0) {
          combatState.combatEffects.splice(i, 1);
        }
      }
    }

    // Pure draw - mutating sim state from here would double up whenever a frame runs more than
    // one simulation step. See updateCombatEffects above.
    function drawCombatEffects(c) {
      for (let i = 0; i < combatState.combatEffects.length; i++) {
        const eff = combatState.combatEffects[i];
        c.fillStyle = eff.color;
        c.font = 'bold 12px monospace';
        c.textAlign = 'center';
        c.shadowColor = '#000000';
        c.shadowBlur = 4;
        c.fillText(eff.text, eff.x, eff.y);
        c.shadowBlur = 0;
      }
    }

    // ==========================================
    // PROCEDURAL TEXTURE GENERATION
    // ==========================================
    function buildDefaultTextures() {
      const cv = document.createElement('canvas');
      cv.width = cv.height = TEX_SIZE;
      const c = cv.getContext('2d');
      c.imageSmoothingEnabled = false;

      // Windows 95 Crimson Red Brick Wall
      c.fillStyle = '#ffffff';
      c.fillRect(0, 0, TEX_SIZE, TEX_SIZE);

      const rows = 4;
      const rowHeight = TEX_SIZE / rows;
      const mortar = 8;

      for (let r = 0; r < rows; r++) {
        const y = r * rowHeight + mortar / 2;
        const h = rowHeight - mortar;
        const off = (r % 2 === 0) ? 0 : TEX_SIZE / 4;

        for (let x = -TEX_SIZE / 2; x < TEX_SIZE * 1.5; x += TEX_SIZE / 2) {
          const bx = x + off + mortar / 2;
          const bw = TEX_SIZE / 2 - mortar;

          c.fillStyle = '#9e1414';
          c.fillRect(bx, y, bw, h);

          c.fillStyle = 'rgba(239, 68, 68, 0.45)';
          c.fillRect(bx + 2, y + 2, bw - 4, 3);
          c.fillRect(bx + 2, y + 2, 3, h - 4);

          c.fillStyle = 'rgba(69, 10, 10, 0.55)';
          c.fillRect(bx + 2, y + h - 5, bw - 4, 3);
          c.fillRect(bx + bw - 5, y + 2, 3, h - 4);
        }
      }
      wallTexture = c.getImageData(0, 0, TEX_SIZE, TEX_SIZE);

      // Drop Ceiling
      c.fillStyle = '#f8fafc';
      c.fillRect(0, 0, TEX_SIZE, TEX_SIZE);
      c.strokeStyle = '#94a3b8';
      c.lineWidth = 4;
      c.strokeRect(0, 0, TEX_SIZE, TEX_SIZE);
      c.beginPath();
      c.moveTo(0, TEX_SIZE / 2); c.lineTo(TEX_SIZE, TEX_SIZE / 2);
      c.moveTo(TEX_SIZE / 2, 0); c.lineTo(TEX_SIZE / 2, TEX_SIZE);
      c.stroke();
      ceilingTexture = c.getImageData(0, 0, TEX_SIZE, TEX_SIZE);

      // Parquet Floor
      c.fillStyle = '#c27e2c';
      c.fillRect(0, 0, TEX_SIZE, TEX_SIZE);
      const half = TEX_SIZE / 2;
      for (let py = 0; py < 2; py++) {
        for (let px = 0; px < 2; px++) {
          const ox = px * half;
          const oy = py * half;
          const isHoriz = (px + py) % 2 === 0;
          c.strokeStyle = '#78350f';
          c.lineWidth = 2;
          c.strokeRect(ox, oy, half, half);
          for (let k = 1; k <= 3; k++) {
            c.beginPath();
            if (isHoriz) {
              c.moveTo(ox, oy + (half / 4) * k);
              c.lineTo(ox + half, oy + (half / 4) * k);
            } else {
              c.moveTo(ox + (half / 4) * k, oy);
              c.lineTo(ox + (half / 4) * k, oy + half);
            }
            c.stroke();
          }
        }
      }
      floorTexture = c.getImageData(0, 0, TEX_SIZE, TEX_SIZE);

      buildLanternWallFromBase(wallTexture, "Windows 95");
      buildExitStairsTexture("Windows 95", wallTexture);
      buildDoorTexture(wallTexture, "Windows 95");
      buildOpenDoorTexture();
      buildSwitchWallTextures(wallTexture, "Windows 95");
    }

    function buildLanternWallFromBase(baseWallImageData, styleName = "Windows 95") {
      const cv = document.createElement('canvas');
      cv.width = cv.height = TEX_SIZE;
      const c = cv.getContext('2d');
      c.imageSmoothingEnabled = false;

      c.putImageData(baseWallImageData, 0, 0);

      const isWin95 = styleName.toLowerCase().includes('windows');

      const radGrad = c.createRadialGradient(128, 95, 10, 128, 95, 115);
      radGrad.addColorStop(0, 'rgba(255, 220, 90, 0.85)');
      radGrad.addColorStop(0.5, 'rgba(245, 158, 11, 0.4)');
      radGrad.addColorStop(1, 'rgba(0, 0, 0, 0)');
      c.fillStyle = radGrad;
      c.fillRect(18, 0, 220, 220);

      if (aiLanternImg && aiLanternImg.complete && aiLanternImg.naturalWidth > 0) {
        // AI-generated fixture themed to this dungeon's own style (see lantern_p in
        // server.py's get_surface_prompts) - matted onto the wall the same way the
        // background-removed weapon/shield sprites are, bottom-anchored over the bracket
        // position the procedural shapes below used.
        //
        // The model is only asked WHAT the object is, never to render it lit: FLUX schnell at
        // 4 steps returns a convincing themed object but renders actual emission maybe half the
        // time (a haunted manor came back with glowing windows, a taco came back looking like
        // lunch), and BiRefNet crops off any halo it does draw. So the "lit" half is done here
        // instead, where it is deterministic and every theme gets it.
        //
        // Sizing matches the footprint the procedural crystal sconce below used to occupy
        // (roughly 36x96 of the 256x256 texture).
        const maxW = 60, maxH = 100;
        const scale = Math.min(maxW / aiLanternImg.naturalWidth, maxH / aiLanternImg.naturalHeight, 1);
        const dw = aiLanternImg.naturalWidth * scale;
        const dh = aiLanternImg.naturalHeight * scale;
        const dx = 128 - dw / 2;
        const dy = 146 - dh;
        const gx = dx + dw / 2;
        const gy = dy + dh / 2;

        // Outer bloom first, additive, so light appears to spill from the fixture onto the wall.
        const bloom = c.createRadialGradient(gx, gy, 2, gx, gy, Math.max(dw, dh) * 0.95);
        bloom.addColorStop(0, 'rgba(255, 236, 160, 0.80)');
        bloom.addColorStop(0.45, 'rgba(255, 176, 60, 0.32)');
        bloom.addColorStop(1, 'rgba(255, 140, 0, 0)');
        c.globalCompositeOperation = 'lighter';
        c.fillStyle = bloom;
        c.fillRect(dx - dw, dy - dh * 0.5, dw * 3, dh * 2.2);
        c.globalCompositeOperation = 'source-over';

        // Then the sprite, pre-lit on its own canvas. 'source-atop' confines the warm wash to
        // the sprite's own alpha, so the transparent margin never picks up a rectangular haze.
        const lg = document.createElement('canvas');
        lg.width = Math.max(1, Math.ceil(dw));
        lg.height = Math.max(1, Math.ceil(dh));
        const lc = lg.getContext('2d');
        lc.imageSmoothingEnabled = true;
        // Mirror the fixture, same reason buildDoorTexture pre-flips its slab: the raycaster
        // flips texX on two of the four wall faces, and the base wall this composites onto is
        // already pre-mirrored (imageToTexture(imgW, true)) to cancel that. Drawn straight, the
        // fixture ends up the opposite hand from the wall it hangs on and mirrored across half
        // the maze's lanterns. Flipping it here inside its own box keeps dx/dy and the centred
        // glow gradients untouched.
        lc.translate(lg.width, 0);
        lc.scale(-1, 1);
        lc.drawImage(aiLanternImg, 0, 0, lg.width, lg.height);
        lc.setTransform(1, 0, 0, 1, 0, 0);
        const inner = lc.createRadialGradient(lg.width / 2, lg.height / 2, 1,
                                              lg.width / 2, lg.height / 2,
                                              Math.max(lg.width, lg.height) * 0.7);
        inner.addColorStop(0, 'rgba(255, 245, 200, 0.72)');
        inner.addColorStop(0.6, 'rgba(255, 190, 80, 0.40)');
        inner.addColorStop(1, 'rgba(255, 150, 40, 0.16)');
        lc.globalCompositeOperation = 'source-atop';
        lc.fillStyle = inner;
        lc.fillRect(0, 0, lg.width, lg.height);

        c.imageSmoothingEnabled = true;
        c.drawImage(lg, dx, dy);
        c.imageSmoothingEnabled = false;
      } else if (isWin95) {
        // Windows 95 Logo Lantern. Flipped for the same reason as the AI fixture above - the
        // raycaster mirrors texX on two of the four faces and the base wall is pre-mirrored to
        // match, so the logo's red/green/blue/yellow quadrants have to be pre-mirrored too or
        // they land on the wrong side across half the maze.
        c.translate(TEX_SIZE, 0); c.scale(-1, 1);
        c.fillStyle = '#18181b'; c.fillRect(122, 112, 12, 30);
        c.strokeStyle = '#000000'; c.lineWidth = 4;
        c.beginPath(); c.moveTo(128, 115); c.lineTo(128, 70); c.stroke();

        c.fillStyle = '#27272a';
        c.beginPath(); c.moveTo(108, 70); c.lineTo(148, 70); c.lineTo(128, 54); c.closePath(); c.fill();

        c.fillStyle = '#ef4444'; c.fillRect(112, 72, 14, 14);
        c.fillStyle = '#22c55e'; c.fillRect(130, 72, 14, 14);
        c.fillStyle = '#3b82f6'; c.fillRect(112, 90, 14, 14);
        c.fillStyle = '#eab308'; c.fillRect(130, 90, 14, 14);

        c.strokeStyle = '#09090b'; c.lineWidth = 3;
        c.strokeRect(112, 72, 32, 32);
        c.setTransform(1, 0, 0, 1, 0, 0);
      } else {
        // Fallback when no AI lantern art came back (generation failure, older bundle, etc).
        // Classic Dungeon Glowing Crystal Sconce. Drawn symmetric about x=128, so it needs no
        // flip - the mirror the AI and Win95 fixtures correct for is a no-op here.
        // Iron Bracket
        c.fillStyle = '#18181b';
        c.fillRect(120, 102, 16, 24);
        c.fillRect(112, 98, 32, 6);
        c.fillStyle = '#3f3f46';
        c.fillRect(112, 98, 32, 2);

        // Glowing Core
        const glowGrad = c.createLinearGradient(128, 50, 128, 98);
        glowGrad.addColorStop(0, '#fef08a');
        glowGrad.addColorStop(0.4, '#f59e0b');
        glowGrad.addColorStop(1, '#b45309');
        c.fillStyle = glowGrad;
        
        c.beginPath();
        c.moveTo(128, 50);
        c.lineTo(144, 75);
        c.lineTo(136, 98);
        c.lineTo(120, 98);
        c.lineTo(112, 75);
        c.closePath();
        c.fill();
        
        c.strokeStyle = '#fde047';
        c.lineWidth = 2;
        c.stroke();
      }

      wallLanternTexture = c.getImageData(0, 0, TEX_SIZE, TEX_SIZE);
    }

    // Average colour of a wall/floor texture, so the stairwell below can be cut from the same
    // stone as the dungeon it sits in rather than being one fixed grey in every theme.
    function averageTextureColor(imgData, fallback = { r: 122, g: 118, b: 112 }) {
      if (!imgData || !imgData.data) return fallback;
      const d = imgData.data;
      let r = 0, g = 0, b = 0, n = 0;
      // Every 64th pixel is plenty for a mean and keeps this off the frame budget.
      for (let i = 0; i < d.length; i += 4 * 64) {
        r += d[i]; g += d[i + 1]; b += d[i + 2]; n++;
      }
      if (!n) return fallback;
      return { r: r / n, g: g / n, b: b / n };
    }

    // The exit used to be a floating "End" placard. It is a STAIRWELL now: a stone opening cut
    // into the far wall of the exit cell with steps descending away into the dark.
    //
    // Drawn in one-point perspective and anchored to the FLOOR at render time (see the exit
    // pass in render3D), not centred on the horizon the way the placard was. That is what makes
    // it read as a hole in the world instead of a sign hanging in one: the nearest step edge
    // meets the floor line of the exit cell, and each step further down is drawn thinner,
    // narrower and darker, converging on a vanishing point just under eye level - which is
    // exactly where descending steps go.
    //
    // The 256x128 canvas is authored at roughly the aspect the renderer draws it at (one cell
    // wide by a full wall tall), so the steps are not badly squashed on screen.
    const EXIT_SPR_W = 256, EXIT_SPR_H = 128;
    // How much of a wall's height the stairwell sprite takes, measured up from the floor.
    // 1.0 runs the stone surround clear up to the ceiling - anything less leaves a strip of
    // corridor wall showing between the top of the frame and the ceiling (see the lintel course
    // baked into the texture, which is what reads as "stone above the arch" now).
    const EXIT_STAIRS_WALL_FRAC = 1.0;
    function buildExitStairsTexture(styleName = "Windows 95", sourceWallImageData = null) {
      const cv = document.createElement('canvas');
      cv.width = EXIT_SPR_W;
      cv.height = EXIT_SPR_H;
      const c = cv.getContext('2d');
      c.imageSmoothingEnabled = false;
      c.clearRect(0, 0, EXIT_SPR_W, EXIT_SPR_H);

      // Normalise the sampled wall to a fixed, fairly dark luminance. Sampling alone gives a
      // pastel stairwell in a bright theme and a black one in a dark theme; renormalising keeps
      // the dungeon's HUE while pinning the tone, so the stairs read as shadowed stone whatever
      // the walls are made of.
      const raw = averageTextureColor(sourceWallImageData);
      const luma = 0.2126 * raw.r + 0.7152 * raw.g + 0.0722 * raw.b;
      const norm = luma > 8 ? 118 / luma : 1;
      const base = { r: raw.r * norm, g: raw.g * norm, b: raw.b * norm };
      // m scales the stone; tint blends it towards the warm light spilling down the stairwell.
      const stone = (m, tint = 0, a = 1) => {
        const t = Math.max(0, Math.min(1, tint)) * 0.5;
        const r = Math.min(255, base.r * m * (1 - t) + 255 * t);
        const g = Math.min(255, base.g * m * (1 - t) + 238 * t);
        const b = Math.min(255, base.b * m * (1 - t) + 200 * t);
        return `rgba(${r | 0},${g | 0},${b | 0},${a})`;
      };

      // --- The opening. Its top edge is the lintel of the arch, its bottom edge is the floor.
      // Filled with deep shadow rather than pure black so the corners the flight does not reach
      // read as the stairwell's own unlit walls instead of holes punched in the world.
      const JAMB = 18;                    // stone left and right of the opening
      const LINTEL = 14;                  // stone above it
      const openL = JAMB, openR = EXIT_SPR_W - JAMB, openT = LINTEL, openB = EXIT_SPR_H;
      const cx = EXIT_SPR_W / 2;
      const voidGrad = c.createLinearGradient(0, openB, 0, openT);
      voidGrad.addColorStop(0, stone(0.10));
      voidGrad.addColorStop(1, stone(0.30));
      c.fillStyle = voidGrad;
      c.fillRect(openL, openT, openR - openL, openB - openT);

      // --- The flight. Step 0 is nearest, at the bottom, spanning the full opening; each one
      // after is shorter (foreshortening compresses the treads), narrower (the walls converge)
      // and BRIGHTER - the stairs climb out of the dungeon towards daylight, which is also what
      // makes them legible from the far end of a dark corridor.
      const STEPS = 14;
      const geom = [];                     // remembered for the side walls below
      let y = EXIT_SPR_H;                  // front edge of the nearest step
      let stepH = 23;                      // its on-screen height
      let halfW = (openR - openL) / 2;
      for (let i = 0; i < STEPS && stepH > 0.6; i++) {
        const nextHalfW = halfW * 0.908;
        const top = y - stepH;
        // How far up the flight this step is. Squared-ish so the brightening reads as light
        // falling from one place rather than a flat ramp.
        const up = Math.pow(i / (STEPS - 1), 1.4);

        geom.push({ y, halfW });

        // Tread - the flat you would step on, narrowing as it recedes.
        c.fillStyle = stone(0.52 + up * 0.58, up * 0.85);
        c.beginPath();
        c.moveTo(cx - halfW, y);
        c.lineTo(cx + halfW, y);
        c.lineTo(cx + nextHalfW, top);
        c.lineTo(cx - nextHalfW, top);
        c.closePath();
        c.fill();

        // Riser - the vertical face under the step's front edge, always in its own shadow.
        // It is what reads as "step" rather than "stripe".
        const riserH = Math.max(1, stepH * 0.34);
        c.fillStyle = stone(0.18 + up * 0.30, up * 0.25);
        c.beginPath();
        c.moveTo(cx - halfW, y);
        c.lineTo(cx + halfW, y);
        c.lineTo(cx + halfW * 0.997, y - riserH);
        c.lineTo(cx - halfW * 0.997, y - riserH);
        c.closePath();
        c.fill();

        // Lit nosing along the front edge, catching the light from above.
        c.fillStyle = stone(0.85 + up * 0.5, up, 0.9);
        c.fillRect(cx - halfW, y - riserH - 1, halfW * 2, 1.4);

        y = top;
        stepH *= 0.812;
        halfW = nextHalfW;
      }

      // --- Side walls, following the flight up. Drawn as one polygon per side from the
      // opening's edge to each step's outer corner, so the treads are bounded by stone all the
      // way up instead of ending in a black wedge.
      const flightTop = y, flightHalfW = halfW;
      for (const side of [-1, 1]) {
        const wallGrad = c.createLinearGradient(0, EXIT_SPR_H, 0, flightTop);
        wallGrad.addColorStop(0, stone(0.20));
        wallGrad.addColorStop(1, stone(0.46, 0.30));
        c.fillStyle = wallGrad;
        c.beginPath();
        c.moveTo(cx + side * (openR - openL) / 2, EXIT_SPR_H);
        c.lineTo(cx + side * (openR - openL) / 2, openT);
        c.lineTo(cx + side * flightHalfW, flightTop);
        for (let i = geom.length - 1; i >= 0; i--) {
          c.lineTo(cx + side * geom[i].halfW, geom[i].y);
        }
        c.closePath();
        c.fill();
      }

      // --- The light the stairs climb towards. Sits at the top of the flight and spills a
      // little way back down it, which is what tells the player these go OUT rather than
      // deeper in - and makes the exit findable from the dark end of a long corridor.
      const glowR = (openR - openL) * 0.5;
      const glow = c.createRadialGradient(cx, flightTop + 2, 1, cx, flightTop + 2, glowR);
      glow.addColorStop(0, 'rgba(255,242,214,0.92)');
      glow.addColorStop(0.35, 'rgba(255,232,186,0.42)');
      glow.addColorStop(1, 'rgba(255,226,170,0)');
      c.fillStyle = glow;
      c.fillRect(openL, openT, openR - openL, EXIT_SPR_H - openT);

      // --- Stone surround. Painted LAST and only outside the opening, so the arch frames the
      // hole rather than being drawn over by it.
      c.fillStyle = stone(0.78);
      c.fillRect(0, 0, openL, EXIT_SPR_H);                       // left jamb
      c.fillRect(openR, 0, EXIT_SPR_W - openR, EXIT_SPR_H);      // right jamb
      c.fillRect(0, 0, EXIT_SPR_W, openT);                       // lintel
      // Bevel: lit on top and left, shadowed on the inner reveal, which is what gives the
      // opening depth instead of reading as a black rectangle painted on the wall.
      c.fillStyle = stone(1.18, 0.9);
      c.fillRect(0, 0, EXIT_SPR_W, 3);
      c.fillRect(0, 0, 3, EXIT_SPR_H);
      c.fillStyle = stone(0.42, 0.95);
      c.fillRect(openL - 3, openT - 3, (openR - openL) + 6, 3);  // under the lintel
      c.fillRect(openL - 3, openT, 3, EXIT_SPR_H - openT);       // inner reveal, left
      c.fillRect(openR, openT, 3, EXIT_SPR_H - openT);           // inner reveal, right

      // Block courses across the surround, so the frame reads as masonry at a glance.
      c.fillStyle = stone(0.55, 0.75);
      for (let by = 10; by < EXIT_SPR_H; by += 22) {
        c.fillRect(0, by, openL - 3, 1.5);
        c.fillRect(openR + 3, by, EXIT_SPR_W - openR - 3, 1.5);
      }

      exitStairsTexture = c.getImageData(0, 0, EXIT_SPR_W, EXIT_SPR_H);
    }

    // Full-cell wall texture for a closed door (MAP tile 3). Uses the style-matched AI slab
    // (aiDoorImg) when it decoded, otherwise paints a procedural banded slab over the wall.
    function buildDoorTexture(baseWallImageData, styleName = "Windows 95") {
      if (aiDoorImg && aiDoorImg.complete && aiDoorImg.naturalWidth > 0) {
        // Mirror the slab horizontally. The wall raycaster flips texX on the face the player
        // actually walks up to a door from (see render3D's `side === 0 && rayDirX > 0` etc.),
        // which is harmless on tiling wall art but reads as backwards text / handle-on-the-
        // wrong-side on the door's AI cutout. Pre-flipping the source cancels that out so the
        // door reads correctly on approach.
        const cv = document.createElement('canvas');
        cv.width = cv.height = TEX_SIZE;
        const c = cv.getContext('2d');
        c.imageSmoothingEnabled = false;
        c.translate(TEX_SIZE, 0);
        c.scale(-1, 1);
        c.drawImage(aiDoorImg, 0, 0, TEX_SIZE, TEX_SIZE);
        doorTexture = c.getImageData(0, 0, TEX_SIZE, TEX_SIZE);
        return;
      }
      const cv = document.createElement('canvas');
      cv.width = cv.height = TEX_SIZE;
      const c = cv.getContext('2d');
      c.imageSmoothingEnabled = false;
      if (baseWallImageData) c.putImageData(baseWallImageData, 0, 0);
      else { c.fillStyle = '#3f3f46'; c.fillRect(0, 0, TEX_SIZE, TEX_SIZE); }

      const isWin95 = styleName.toLowerCase().includes('windows');
      const S = TEX_SIZE;
      const m = 18;                                   // stone jamb margin

      // recessed doorway
      c.fillStyle = isWin95 ? '#6b7280' : '#1f2937';
      c.fillRect(m, m, S - 2 * m, S - 2 * m);

      // planks
      const px = m + 8, pw = S - 2 * m - 16, planks = 4;
      const plankW = pw / planks;
      for (let i = 0; i < planks; i++) {
        c.fillStyle = isWin95
          ? (i % 2 ? '#9ca3af' : '#7d8590')
          : (i % 2 ? '#5b4632' : '#4a3826');
        c.fillRect(px + i * plankW, m + 8, plankW - 2, S - 2 * m - 16);
      }

      // iron bands
      c.fillStyle = isWin95 ? '#334155' : '#27272a';
      c.fillRect(m + 4, m + 30, S - 2 * m - 8, 14);
      c.fillRect(m + 4, S - m - 44, S - 2 * m - 8, 14);

      // ring handle
      c.strokeStyle = isWin95 ? '#1e293b' : '#18181b';
      c.lineWidth = 7;
      c.beginPath(); c.arc(S / 2 + 34, S / 2, 20, 0, Math.PI * 2); c.stroke();
      // keyhole plate
      c.fillStyle = isWin95 ? '#1e293b' : '#18181b';
      c.fillRect(S / 2 + 24, S / 2 + 24, 16, 22);
      c.fillStyle = isWin95 ? '#0f172a' : '#000000';
      c.beginPath(); c.arc(S / 2 + 32, S / 2 + 31, 4, 0, Math.PI * 2); c.fill();
      c.fillRect(S / 2 + 31, S / 2 + 31, 3, 10);

      // frame outline
      c.strokeStyle = isWin95 ? '#e2e8f0' : '#111827';
      c.lineWidth = 4;
      c.strokeRect(m, m, S - 2 * m, S - 2 * m);

      doorTexture = c.getImageData(0, 0, TEX_SIZE, TEX_SIZE);
    }

    // The opened gate (MAP tile 6). A door that vanished on unlocking used to leave the player
    // no evidence a gate had ever been there, so an opened one keeps the jamb - but the leaf
    // itself is just gone, not swung open against a post: a swung leaf is drawn edge-on this
    // close up (the doorway is only ever seen face-on or from the crossing corridor - see the
    // per-column ray-segment pass in render3D), which reads as a random sliver of door
    // material jammed in the opening rather than as a door standing open. Erasing it entirely
    // reads as "open" at every angle, with no geometry that can look wrong.
    //
    // Every pixel comes from doorTexture - the closed door - so whatever style the generator
    // returned, the open gate's jamb matches it with no second piece of art to generate.
    // Sampled from the vertical band the wall renderer actually shows (the texTop crop in
    // render3D) so the open jamb lines up with the closed door it replaces.
    function buildOpenDoorTexture() {
      if (!doorTexture) { doorOpenTexture = null; return; }

      const bandY = Math.round((TEX_SIZE * (1 - WALL_HEIGHT)) / 2);
      const bandH = Math.round(TEX_SIZE * WALL_HEIGHT);

      const src = document.createElement('canvas');
      src.width = src.height = TEX_SIZE;
      src.getContext('2d').putImageData(doorTexture, 0, 0);

      const cv = document.createElement('canvas');
      cv.width = DOOR_SPR_W; cv.height = DOOR_SPR_H;
      const c = cv.getContext('2d');
      c.imageSmoothingEnabled = false;

      const post = Math.round(DOOR_SPR_W * 0.13);      // side jamb thickness
      const lintel = Math.round(DOOR_SPR_H * 0.12);    // head jamb thickness
      const openW = DOOR_SPR_W - 2 * post;
      const openH = DOOR_SPR_H - lintel;               // opening runs down to the floor

      // Punching a plain rectangle here left the closed door's own arched top (whatever
      // curve the generated art actually drew) hanging as a solid chunk above a flat-topped
      // hole - a doorway that reads as "the wall opened," not as a door-shaped cutout. So the
      // hole itself is an arch: straight jambs up to the springline, then a rounded top - a
      // reasonable universal doorway silhouette given the closed art's real curve isn't known
      // (it's a plain opaque generated image, no alpha to trace).
      const archH = Math.min(openH * 0.38, openW * 0.55);
      const springY = lintel + archH;
      const archCx = post + openW / 2;
      function archPath() {
        c.beginPath();
        c.moveTo(post, lintel + openH);
        c.lineTo(post, springY);
        c.ellipse(archCx, springY, openW / 2, archH, 0, Math.PI, 2 * Math.PI, false);
        c.lineTo(post + openW, lintel + openH);
        c.closePath();
      }

      // The closed door's visible band, with the arch-shaped opening punched out of it ->
      // jamb ring, no leaf.
      c.drawImage(src, 0, bandY, TEX_SIZE, bandH, 0, 0, DOOR_SPR_W, DOOR_SPR_H);
      archPath();
      c.globalCompositeOperation = 'destination-out';
      c.fill();
      c.globalCompositeOperation = 'source-over';

      // Dark reveals down the inside of each post + a shadow under the arch, so the opening
      // reads as a threshold with depth rather than a hole cut flat into the wall. Clipped to
      // the same arch path so the shading can't paint into the solid spandrels above the curve.
      c.save();
      archPath();
      c.clip();

      const reveal = c.createLinearGradient(post, 0, post + openW, 0);
      reveal.addColorStop(0, 'rgba(0, 0, 0, 0.55)');
      reveal.addColorStop(0.13, 'rgba(0, 0, 0, 0)');
      reveal.addColorStop(0.87, 'rgba(0, 0, 0, 0)');
      reveal.addColorStop(1, 'rgba(0, 0, 0, 0.55)');
      c.fillStyle = reveal;
      c.fillRect(post, lintel, openW, openH);

      const head = c.createLinearGradient(0, lintel, 0, springY);
      head.addColorStop(0, 'rgba(0, 0, 0, 0.5)');
      head.addColorStop(1, 'rgba(0, 0, 0, 0)');
      c.fillStyle = head;
      c.fillRect(post, lintel, openW, archH);

      c.restore();

      doorOpenTexture = c.getImageData(0, 0, DOOR_SPR_W, DOOR_SPR_H);
    }

    // OFF/ON wall textures for a switch (MAP tiles 4 and 5), painted onto one face of the tile
    // only - see _switchFaceHit.
    //
    // ONE piece of art, two states. The fixture is drawn once onto a transparent overlay, and
    // the ON texture is that same overlay with its RGB inverted (alpha untouched, so the
    // cutout's silhouette is identical in both). Nothing else changes: same plate, same
    // position, same pose, same wall behind it.
    //
    // The server used to generate the thrown pose as a second image. Two independent renders
    // produced two visibly different fixtures, and an img2img pass over the off render kept
    // the fixture but barely moved the handle - see get_gate_prompts. Inverting is the one
    // approach that cannot drift: it is the same pixels, and "photo-negative" is not a state
    // any wall texture reaches by accident, so it reads as thrown at corridor distance where a
    // few degrees of handle rotation did not.
    //
    // The fixture is deliberately small and chunky - the AI cutout is downsampled to SWITCH_SRC
    // px before being blown back up with smoothing off - so it sits in the wall at roughly
    // lantern scale and at the wall texture's own resolution, instead of floating over it as a
    // smooth high-res decal.
    function buildSwitchWallTextures(baseWallImageData, styleName = "Windows 95") {
      const haveArt = aiSwitchImg && aiSwitchImg.complete && aiSwitchImg.naturalWidth > 0;
      const isWin95 = styleName.toLowerCase().includes('windows');

      const cx = 128;                 // fixture centre on the wall
      const baseY = 142;              // where the fixture's bottom edge sits
      const maxW = 34, maxH = 56;     // fixture footprint
      const SWITCH_SRC = 24;          // chunky-pixel source size for the AI cutout

      // The fixture alone, on a transparent TEX_SIZE canvas - kept separate from the wall so
      // the inversion below hits the hardware and nothing else. Inverting the composited cell
      // would photo-negative the bricks around it too, which reads as a lighting bug rather
      // than as a thrown lever.
      const fixture = document.createElement('canvas');
      fixture.width = fixture.height = TEX_SIZE;
      const fx = fixture.getContext('2d');
      fx.imageSmoothingEnabled = false;

      if (haveArt) {
        // Downsample the cutout to its own small canvas first, fit inside maxW/maxH.
        const scale = Math.min(maxW / aiSwitchImg.naturalWidth, maxH / aiSwitchImg.naturalHeight, 1);
        const fw = Math.max(1, Math.round(aiSwitchImg.naturalWidth * scale));
        const fh = Math.max(1, Math.round(aiSwitchImg.naturalHeight * scale));
        const longest = Math.max(fw, fh);
        const sw = Math.max(1, Math.round(SWITCH_SRC * (fw / longest)));
        const sh = Math.max(1, Math.round(SWITCH_SRC * (fh / longest)));
        const small = document.createElement('canvas');
        small.width = sw; small.height = sh;
        const sc = small.getContext('2d');
        sc.imageSmoothingEnabled = true;
        // The AI cutout comes back mirrored (handle on the wrong side) - flip it horizontally
        // here so the fixture reads correctly on the wall.
        sc.translate(sw, 0);
        sc.scale(-1, 1);
        sc.drawImage(aiSwitchImg, 0, 0, sw, sh);
        fx.drawImage(small, cx - fw / 2, baseY - fh, fw, fh);
      } else {
        // Procedural fallback: a plate, a pivot and a lever at rest. No pose variant - the
        // inversion is the state tell here exactly as it is for the AI art.
        fx.fillStyle = isWin95 ? '#94a3b8' : '#27272a';
        fx.fillRect(cx - 11, baseY - 34, 22, 34);
        fx.strokeStyle = isWin95 ? '#475569' : '#3f3f46';
        fx.lineWidth = 2;
        fx.strokeRect(cx - 11, baseY - 34, 22, 34);

        const pivotY = baseY - 17;
        const leverColor = isWin95 ? '#b91c1c' : '#a1a1aa';
        const tipX = cx - 9, tipY = pivotY + 13;
        fx.strokeStyle = leverColor;
        fx.lineWidth = 5;
        fx.beginPath(); fx.moveTo(cx, pivotY); fx.lineTo(tipX, tipY); fx.stroke();
        fx.fillStyle = leverColor;
        fx.beginPath(); fx.arc(tipX, tipY, 4, 0, Math.PI * 2); fx.fill();

        fx.fillStyle = '#52525b';
        fx.beginPath(); fx.arc(cx, pivotY, 4, 0, Math.PI * 2); fx.fill();
      }

      // The thrown fixture: same canvas, RGB flipped. Alpha is copied through untouched, so
      // transparent margin stays transparent and the soft edge of the cutout still feathers.
      const inverted = document.createElement('canvas');
      inverted.width = inverted.height = TEX_SIZE;
      const ictx = inverted.getContext('2d');
      const fixData = fx.getImageData(0, 0, TEX_SIZE, TEX_SIZE);
      const px = fixData.data;
      for (let i = 0; i < px.length; i += 4) {
        px[i] = 255 - px[i];
        px[i + 1] = 255 - px[i + 1];
        px[i + 2] = 255 - px[i + 2];
      }
      ictx.putImageData(fixData, 0, 0);

      function renderPose(on) {
        const c = document.createElement('canvas');
        c.width = c.height = TEX_SIZE;
        const ctx2 = c.getContext('2d');
        ctx2.imageSmoothingEnabled = false;
        if (baseWallImageData) ctx2.putImageData(baseWallImageData, 0, 0);
        ctx2.drawImage(on ? inverted : fixture, 0, 0);
        return ctx2.getImageData(0, 0, TEX_SIZE, TEX_SIZE);
      }

      switchWallOffTexture = renderPose(false);
      switchWallOnTexture = renderPose(true);
    }

    // Is this ray looking at the ONE face of a switch tile that actually carries the fixture?
    //
    // A switch owns a whole map cell, so painting switchWall*Texture on tile 4/5 unconditionally
    // hung the same lever on all four of its faces - three of them facing corridors the switch
    // has nothing to do with, each showing a lever the player can walk up to and not throw. The
    // fixture belongs on exactly one face: the one looking into its host cell (cellX/cellY, the
    // tile the player must stand on, picked by placeGatesAndSwitches). The other three are plain
    // wall, which is also what the minimap and the interact() guard below assume.
    //
    // The hit face's outward normal points back along the ray's last DDA step: a side-0
    // (vertical) hit was entered moving stepX, so the face being looked at is the one at
    // mapX - stepX; side-1 is the same in y. switchList is a handful of entries at most and only
    // rays that actually hit a 4/5 tile get here, so a linear scan is cheaper than keeping a
    // lookup in sync with maze regeneration and snapshot restores.
    function _switchFaceHit(mapX, mapY, side, stepX, stepY) {
      const faceX = side === 0 ? mapX - stepX : mapX;
      const faceY = side === 1 ? mapY - stepY : mapY;
      for (let i = 0; i < switchList.length; i++) {
        const s = switchList[i];
        if (s.x === mapX && s.y === mapY) return s.cellX === faceX && s.cellY === faceY;
      }
      return false;
    }

    // ==========================================
    // LOCKED GATES + SWITCHES  (placed during maze generation)
    // ==========================================
    function _tileKey(x, y) { return x + ',' + y; }

    // In-place Fisher-Yates. braidMaze picks which loops to carve by shuffling the full
    // candidate list and taking a prefix, rather than sampling at random with replacement -
    // the same wall can't be drawn twice, so a budget of N carves really is N carves.
    function _shuffle(arr) {
      for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
      }
      return arr;
    }

    const _ORTHO =[{ dx: 0, dy: -1 }, { dx: 0, dy: 1 }, { dx: -1, dy: 0 }, { dx: 1, dy: 0 }];
    const _NEIGHBORS8 = _ORTHO.concat([
      { dx: -1, dy: -1 }, { dx: 1, dy: -1 }, { dx: -1, dy: 1 }, { dx: 1, dy: 1 }
    ]);

    // Used by the lantern pass below: true if (x,y) touches a still-closed door (3) or a
    // switch (4/5) tile, including diagonally - a torch crowding the archway looks cluttered,
    // and worse, one beside a switch lights up a fixture placeGatesAndSwitches specifically
    // put off the beaten path to be hard to spot.
    function _nearGateOrSwitch(x, y) {
      for (const d of _NEIGHBORS8) {
        const nx = x + d.dx, ny = y + d.dy;
        if (ny < 0 || ny >= MAP_HEIGHT || nx < 0 || nx >= MAP_WIDTH) continue;
        const v = MAP[ny][nx];
        if (v === 3 || v === 4 || v === 5) return true;
      }
      return false;
    }

    // Shortest path over MAP===0 tiles. In a perfect (spanning-tree) maze there is exactly
    // one simple path, so this IS the start->exit route. Returns [{x,y}, ...] or null.
    function _bfsPath(a, b) {
      const prev = new Map();
      prev.set(_tileKey(a.x, a.y), null);
      const queue = [{ x: a.x, y: a.y }];
      let qi = 0;
      while (qi < queue.length) {
        const cur = queue[qi++];
        if (cur.x === b.x && cur.y === b.y) break;
        for (const d of _ORTHO) {
          const nx = cur.x + d.dx, ny = cur.y + d.dy;
          if (ny < 0 || ny >= MAP_HEIGHT || nx < 0 || nx >= MAP_WIDTH) continue;
          if (MAP[ny][nx] !== 0) continue;
          const k = _tileKey(nx, ny);
          if (prev.has(k)) continue;
          prev.set(k, cur);
          queue.push({ x: nx, y: ny });
        }
      }
      if (!prev.has(_tileKey(b.x, b.y))) return null;
      const out = [];
      let node = { x: b.x, y: b.y };
      while (node) { out.push(node); node = prev.get(_tileKey(node.x, node.y)); }
      out.reverse();
      return out;
    }

    // Flood fill from seed over tiles where passableFn(x,y) is true. Returns
    // Map("x,y" -> {x, y, dist}).
    function _flood(seed, passableFn) {
      const out = new Map();
      const start = { x: seed.x, y: seed.y, dist: 0 };
      out.set(_tileKey(seed.x, seed.y), start);
      const queue = [start];
      let qi = 0;
      while (qi < queue.length) {
        const cur = queue[qi++];
        for (const d of _ORTHO) {
          const nx = cur.x + d.dx, ny = cur.y + d.dy;
          if (ny < 0 || ny >= MAP_HEIGHT || nx < 0 || nx >= MAP_WIDTH) continue;
          const k = _tileKey(nx, ny);
          if (out.has(k) || !passableFn(nx, ny)) continue;
          const e = { x: nx, y: ny, dist: cur.dist + 1 };
          out.set(k, e);
          queue.push(e);
        }
      }
      return out;
    }

    // Phase 1 of gating: choose WHERE the 1-3 locked doors go, while the maze is still a
    // spanning tree and the start->exit path is therefore unique. That uniqueness is what makes
    // "evenly spaced along the route" mean anything, so this has to run before braidMaze() adds
    // loops. Returns null when the maze is too small to gate (the caller then places no doors
    // and no switches, exactly as before), otherwise a plan braidMaze() must protect and
    // placeGatesAndSwitches() then stamps.
    function planGates() {
      const path = _bfsPath(startRoom, exitRoom);
      if (!path || path.length < 2) return null;
      const L = path.length - 1;
      if (L < 8) return null;                             // too short to gate comfortably

      // Roughly one gate per 30 steps of route, still capped at 3 and still bounded by how many
      // connector tiles there are to sit on. This used to be a flat min(3, ...), which handed a
      // 33-tile Easy maze the same three doors as a 111-tile Hard one - a gate every ten tiles.
      // That matters more than it looks: braidMaze can only carve loops WITHIN a gate region, so
      // three doors chop a small maze into four ~4-cell pockets with no room for a loop in any of
      // them. Measured over 400 Easy mazes, three gates left 37% of them still perfect (zero
      // loops); one gate leaves 3%. Medium and Hard are big enough that it barely moves them
      // (12.0 vs 12.8 loops on Hard), so this is really about not over-gating the small maps.
      const connectorCount = Math.floor(L / 2);
      let N = Math.min(3, Math.floor(connectorCount / 2), Math.max(1, Math.round(L / 30)));
      if (N < 1) return null;

      // door path-indices: evenly spaced, odd (connector tiles), strictly increasing with a
      // gap >= 2, and at least one cell of slack before the first / after the last.
      const doorIdx = [];
      for (let i = 1; i <= N; i++) {
        let t = Math.round((i * L) / (N + 1));
        if (t % 2 === 0) t -= 1;
        const lo = 1 + 2 * i;
        const hi = (L - 1) - 2 * (N - i);
        if (lo > hi) continue;
        t = Math.max(lo, Math.min(hi, t));
        if (doorIdx.length && t <= doorIdx[doorIdx.length - 1] + 1) {
          t = doorIdx[doorIdx.length - 1] + 2;
        }
        if (t % 2 === 1 && t >= 1 && t <= L - 1 &&
            (!doorIdx.length || t > doorIdx[doorIdx.length - 1])) {
          doorIdx.push(t);
        }
      }
      if (!doorIdx.length) return null;

      const gates = doorIdx.map((t, k) => {
        const prevC = path[t - 1], nextC = path[t + 1];
        return {
          tile: path[t],
          // The path cell the player stands on when this gate blocks them. Switch hosts are
          // scored by distance from here, so a lever never sits in the cell facing its door.
          approach: prevC,
          // Seed for the region the player is confined to until this gate opens: the start for
          // the first door, the cell just past the previous door for the rest.
          seed: (k === 0) ? path[0] : path[doorIdx[k - 1] + 1],
          // Which way the corridor runs through this connector - prevC and nextC are exactly
          // the two cells it joins. Same y (differ in x): an east-west corridor, so the door's
          // OWN plane spans north-south - axis 'y'. Same x: plane spans east-west - axis 'x'.
          // Used by the open-gate render pass to draw the doorway as a properly oriented
          // segment instead of a camera-facing billboard, so it foreshortens correctly (and
          // looks edge-on, not full-width) when glimpsed from a crossing passage. Braiding
          // cannot invalidate this: a connector tile's other two neighbours are (even,even)
          // corner tiles, which nothing ever carves.
          axis: (prevC.y === nextC.y) ? 'y' : 'x',
          // Slice of `path` strictly between this gate's region seed and the gate itself, for
          // the last-resort switch host below.
          lowIdx: (k === 0) ? 2 : doorIdx[k - 1] + 1,
          hiIdx: t - 1
        };
      });

      // Region 0 is everything before door 0; region k+1 starts at the cell just past door k.
      // braidMaze() uses these to label the maze before it carves anything.
      const regionSeeds = [path[0]].concat(doorIdx.map((t) => path[t + 1]));
      return { path, gates, regionSeeds };
    }

    // Phase 2: turn the spanning tree into a MULTICURSAL maze by knocking out extra walls, so
    // corridors rejoin each other instead of every passage having exactly one way in and out.
    // Two passes - dead-end braiding (give a tip a second exit, which makes the corridor that
    // led there into a circuit) and a scatter of cross-corridor shortcuts, which is what stops
    // a long snaking passage from still being a long snaking passage once its tips are tied off.
    //
    // The one thing braiding must NOT do is hand the player a way around a locked gate. Every
    // planned door tile is a cut tile of the tree: it separates the region the player is stuck
    // in from everything past it. So label every floor cell with its gate region (doors treated
    // as walls), then only ever carve BETWEEN TWO CELLS OF THE SAME REGION. Adding edges inside
    // a region can never connect one region to another, so all N doors stay mandatory and
    // placeGatesAndSwitches' solvability proof survives unchanged.
    // Returns the region label map, which relocateExit() needs to keep the Exit behind the
    // last gate.
    function braidMaze(cellRows, cellCols, plan) {
      const regionOf = new Map();
      if (plan) {
        const blocked = new Set(plan.gates.map((g) => _tileKey(g.tile.x, g.tile.y)));
        plan.regionSeeds.forEach((seed, id) => {
          _flood(seed, (x, y) => MAP[y][x] === 0 && !blocked.has(_tileKey(x, y)))
            .forEach((e, key) => { if (!regionOf.has(key)) regionOf.set(key, id); });
        });
      }
      const sameRegion = (a, b) => {
        if (!plan) return true;
        const ra = regionOf.get(_tileKey(a.x, a.y));
        return ra !== undefined && ra === regionOf.get(_tileKey(b.x, b.y));
      };
      // The Exit stays a cul-de-sac in both passes: a shortcut opening straight into it would
      // both shorten the run and cost the arrival its "you found it" beat.
      const isExit = (x, y) => x === exitRoom.x && y === exitRoom.y;

      // Every wall sitting between two carved cells that could legally come out. Only down and
      // right are considered so each wall is enumerated exactly once.
      const candidates = [];
      const byCell = new Map();
      let cellCount = 0;
      for (let r = 0; r < cellRows; r++) {
        for (let c = 0; c < cellCols; c++) {
          const y = r * 2 + 1, x = c * 2 + 1;
          if (MAP[y][x] !== 0) continue;                  // a cell the carve never reached
          cellCount++;
          for (const d of [{ dr: 1, dc: 0 }, { dr: 0, dc: 1 }]) {
            const nr = r + d.dr, nc = c + d.dc;
            if (nr >= cellRows || nc >= cellCols) continue;
            const ny = nr * 2 + 1, nx = nc * 2 + 1;
            if (MAP[ny][nx] !== 0) continue;              // ditto for the neighbour
            const wy = y + d.dr, wx = x + d.dc;
            if (MAP[wy][wx] !== 1) continue;              // that wall is already an opening
            const a = { x, y }, b = { x: nx, y: ny };
            if (!sameRegion(a, b)) continue;              // would bypass a gate - never carve
            const cand = { wx, wy, a, b };
            candidates.push(cand);
            for (const key of [_tileKey(x, y), _tileKey(nx, ny)]) {
              if (!byCell.has(key)) byCell.set(key, []);
              byCell.get(key).push(cand);
            }
          }
        }
      }

      const floorNbCount = (x, y) => {
        let n = 0;
        for (const d of _ORTHO) {
          const ny = y + d.dy, nx = x + d.dx;
          if (ny >= 0 && ny < MAP_HEIGHT && nx >= 0 && nx < MAP_WIDTH && MAP[ny][nx] === 0) n++;
        }
        return n;
      };

      // Pass 1 - dead ends. A cell with one open neighbour is a tip; opening a second wall
      // turns the passage that led to it into a loop. Capped at MAZE.braidDeadEnds so enough
      // tips survive for placeGatesAndSwitches to hide levers down.
      const deadEnds = [];
      for (let r = 0; r < cellRows; r++) {
        for (let c = 0; c < cellCols; c++) {
          const y = r * 2 + 1, x = c * 2 + 1;
          if (MAP[y][x] === 0 && !isExit(x, y) && floorNbCount(x, y) <= 1) deadEnds.push({ x, y });
        }
      }
      _shuffle(deadEnds);
      const braidTarget = Math.round(deadEnds.length * MAZE.braidDeadEnds);
      let braided = 0;
      for (const de of deadEnds) {
        if (braided >= braidTarget) break;
        if (floorNbCount(de.x, de.y) > 1) continue;       // an earlier braid already opened it
        const opts = (byCell.get(_tileKey(de.x, de.y)) || [])
          .filter((o) => MAP[o.wy][o.wx] === 1 && !isExit(o.a.x, o.a.y) && !isExit(o.b.x, o.b.y));
        if (!opts.length) continue;
        const pick = opts[Math.floor(Math.random() * opts.length)];
        MAP[pick.wy][pick.wx] = 0;
        braided++;
      }

      // Pass 2 - shortcuts across the middle of long corridors, which is what gives a route a
      // choice partway along it rather than only where a dead end used to be.
      _shuffle(candidates);
      let cut = 0;
      const extraTarget = Math.round(cellCount * MAZE.extraLoops);
      for (const cand of candidates) {
        if (cut >= extraTarget) break;
        if (MAP[cand.wy][cand.wx] !== 1) continue;        // pass 1 already took this one
        if (isExit(cand.a.x, cand.a.y) || isExit(cand.b.x, cand.b.y)) continue;
        MAP[cand.wy][cand.wx] = 0;
        cut++;
      }
      return regionOf;
    }

    // A cell the carve never reached is still solid wall at its (odd,odd) centre, and so is
    // every connector around it. Those are the cells the stairs' hallway is grown through, and
    // growing it there is precisely what keeps it off the difficulty budget: `grids` counts
    // CARVED corridors, and by definition none of these were carved. Returns the steps out of
    // `cell` that land on one, each carrying the connector wall that comes out with it.
    function _virginHallSteps(cell) {
      const out = [];
      for (const d of _ORTHO) {
        const wx = cell.x + d.dx, wy = cell.y + d.dy;
        const nx = cell.x + d.dx * 2, ny = cell.y + d.dy * 2;
        if (nx < 1 || nx >= MAP_WIDTH - 1 || ny < 1 || ny >= MAP_HEIGHT - 1) continue;
        if (MAP[ny][nx] !== 1 || MAP[wy][wx] !== 1) continue;
        out.push({ x: nx, y: ny, wx, wy, dx: d.dx, dy: d.dy });
      }
      return out;
    }

    // The longest chain of never-carved cells leading away from `cell`, capped at `limit`.
    // Depth-first with backtracking rather than a greedy walk, because the first cell that
    // looks free is often a one-cell pocket with solid rock behind it, and settling for that
    // would leave the stairs on a stub instead of a hallway.
    //
    // Carrying on in the SAME direction is tried first, so a run that can be straight is
    // straight - a hallway the player can see the stairs down from its far end is the whole
    // reason for building one, and a switchbacking chain of the same length hides them until
    // the last corner. The remaining turns are shuffled, so two dungeons that happen to pick
    // the same dead end do not get the same hallway.
    function _growExitHall(cell, limit, dir, taken) {
      if (limit <= 0) return [];
      const opts = _shuffle(_virginHallSteps(cell)
        .filter((o) => !taken.has(_tileKey(o.x, o.y))));
      if (dir) {
        const turn = (o) => (o.dx === dir.dx && o.dy === dir.dy) ? 0 : 1;
        opts.sort((a, b) => turn(a) - turn(b));
      }
      let best = [];
      for (const o of opts) {
        const k = _tileKey(o.x, o.y);
        taken.add(k);
        const run = [o].concat(_growExitHall(o, limit - 1, o, taken));
        taken.delete(k);
        if (run.length > best.length) best = run;
        if (best.length >= limit) break;        // full length - nothing left to improve on
      }
      return best;
    }

    // The Exit is meant to be the hardest tile in the maze to get to, and up to here it is
    // whichever cell the carve reached last by tree depth. Braiding invalidates that: a
    // shortcut between two corridors can cut a big chunk off the walk without touching the
    // exit cell itself, and measured over 250 hard mazes that alone knocked the start->exit
    // route from 92 steps down to 67. So re-pick it on the FINISHED map - the tile genuinely
    // furthest from the spawn now that every loop exists.
    //
    // Restricted to the region past the last gate, which is what keeps all N doors standing
    // between the player and the Exit; the gates were planned against the old exit, and moving
    // it around inside the final region cannot put it in front of any of them.
    //
    // The Exit must be a DEAD END - stairs at the end of a hallway, walls on the other three
    // sides. That is a hard requirement, not a tie-break: one way in is what lets ONE boss
    // stand between the player and the stairs. An Exit on a corner or a junction has two ways
    // in, and guarding both would take two bosses (see placeEnemyMarkers).
    //
    // Being a dead end was never enough on its own, though. Measured over 400 mazes per
    // difficulty, nearly a third put the stairs one step from a fork - so the "hallway" they
    // sat at the end of was a single tile, the player rounded a corner and was already standing
    // on the Exit, and there was nowhere to put the last fight. So the chosen dead end is no
    // longer the Exit: it is where the Exit's hallway STARTS. MAZE.exitHallCells cells of
    // corridor are carved out past it through cells the maze never used, and the stairs move to
    // the far end of that. What the player gets is a long straight run they can see the
    // stairwell down, with room in it for the boss to stand three tiles back (see
    // placeEnemyMarkers) and corridor on both sides of the fight.
    //
    // The hallway is free: every cell of it was solid wall the carve stopped short of, so the
    // maze proper still has every corridor `grids` paid for.
    //
    // Nothing else carves after this point - braidMaze has already run, the gate pass only
    // stamps floor into walls and the lantern pass only touches MAP===1 - so the hallway carved
    // here is still a hallway on the map the player walks.
    function relocateExit(plan, regionOf) {
      const lastId = plan ? plan.regionSeeds.length - 1 : 0;
      // Doors are not stamped yet, so this floods the maze as it will be with every gate open -
      // i.e. the real walking distance once the player has earned their way through.
      const dist = _flood(startRoom, (x, y) => MAP[y][x] === 0);

      // How much corridor would sit behind the stairs if the hallway were grown off `end`: the
      // carved cells and their connectors first, then - when the anchor was a dead end, since
      // carving through it turns it into an ordinary corridor tile - however much further the
      // maze itself runs on before it forks. This is the number placeEnemyMarkers counts the
      // boss's tiles off, so it stops wherever that walk would: at a fork, at a door (a door is
      // not floor, and the guard will not be stood on one), or at the spawn. Capped, because
      // past a certain length more corridor stops buying anything.
      const HALL_REACH_CAP = 8;
      const reachOf = (end, runLen, gateKeys) => {
        let reach = runLen * 2;                            // each cell brings its connector
        if (!end.from) return reach;                       // junction anchor - it stops there
        let prev = { x: end.x, y: end.y }, cur = end.from;
        while (reach < HALL_REACH_CAP) {
          if (gateKeys.has(_tileKey(cur.x, cur.y))) break;
          if (cur.x === startRoom.x && cur.y === startRoom.y) break;
          reach++;
          const onward = [];
          for (const d of _ORTHO) {
            const nx = cur.x + d.dx, ny = cur.y + d.dy;
            if (ny < 0 || ny >= MAP_HEIGHT || nx < 0 || nx >= MAP_WIDTH) continue;
            if (MAP[ny][nx] !== 0) continue;
            if (nx === prev.x && ny === prev.y) continue;
            onward.push({ x: nx, y: ny });
          }
          if (onward.length !== 1) break;                  // a fork - the hallway ends here
          prev = cur;
          cur = onward[0];
        }
        return reach;
      };

      // Anchors are gathered by GATE TIER. Tier t means "keep the first t doors and let the
      // Exit sit anywhere behind them", so tier lastId is the region past every planned door -
      // what we want, and what we almost always get.
      //
      // The tiers below it are the escape hatch, and two things spring it. Either the last
      // region comes out LANDLOCKED - every cell of it walled in by corridors belonging to
      // earlier regions, with no unused rock anywhere along its edge to tunnel into (those
      // mazes are not short of spare cells; measured, they have as many as any other, the
      // spares are just on the far side of the maze from the region allowed to hold the Exit) -
      // or the last DOOR itself caps the hallway, sitting so close behind the best anchor that
      // the corridor runs into it before the boss has its tiles.
      //
      // Either way the thing to give up is that last door, not the hallway. The Exit moves back
      // a tier and the doors past it are dropped from the plan before placeGatesAndSwitches
      // ever stamps them, so they never become locks on rooms nobody has any reason to enter.
      // Every door that survives is still a cut tile on the way to the Exit, still mandatory,
      // and still opened in order. Measured over 3000 dungeons a side, this fires on 0.8% of
      // Easy, 2.4% of Medium and 7.5% of Hard, and gives up one door when it does - Hard's mean
      // door count goes 2.94 -> 2.86. When that was the maze's LAST door (Easy plans only one)
      // the boss is left with nothing in front of it, and generateAuthentic3DMaze throws the
      // whole carve away and starts again rather than keep it.
      //
      // Dropping a tier only ever ADDS anchors - tier t accepts every cell tier t+1 did, plus
      // the region in front of it - so the search stops at the highest tier that clears
      // BOSS_TILES_FROM_EXIT and never trades away a door it did not need to.
      let best = null, bestRun = [], bestScore = -1, bestTier = lastId;
      for (let tier = lastId; tier >= 0; tier--) {
        // Only the doors this tier keeps count as doors. The ones past it are about to be
        // dropped, so a dead end sitting behind one is a perfectly good anchor again.
        const gateKeys = new Set((plan ? plan.gates.slice(0, tier) : [])
          .map((g) => _tileKey(g.tile.x, g.tile.y)));

        // Every cell of the allowed regions is a possible anchor, not only the dead ends. A
        // dead end is much the better one - the hallway inherits the corridor already running
        // up to it, so it finishes longer than the part we carve - and that is what `from`
        // records, the one way in that corridor arrives by. Junction anchors are what rescue a
        // region with no usable dead end left in it, and they are barely a compromise: the
        // stairs still end at the dead end of a corridor, because the corridor is one we carve.
        //
        // A dead end whose one way in is about to become a door has nowhere for the boss to
        // stand - the guard needs a walkable approach - so it drops back to being an ordinary
        // junction anchor rather than being thrown out; growing a hallway off it is exactly
        // what gives the boss its tiles back.
        const ends = [];
        dist.forEach((e, key) => {
          if (e.x % 2 !== 1 || e.y % 2 !== 1) return;       // cells only, never a connector
          // An unlabelled cell is one the region flood never reached, which puts it behind
          // some door in a pocket of its own - never a place to hang the Exit.
          const rid = regionOf.get(key);
          if (plan && (rid === undefined || rid < tier)) return;
          if (e.x === startRoom.x && e.y === startRoom.y) return;
          const floorNb = [];
          for (const d of _ORTHO) {
            const nx = e.x + d.dx, ny = e.y + d.dy;
            if (ny >= 0 && ny < MAP_HEIGHT && nx >= 0 && nx < MAP_WIDTH && MAP[ny][nx] === 0) {
              floorNb.push({ x: nx, y: ny });
            }
          }
          const deadEnd = floorNb.length === 1 &&
                          !gateKeys.has(_tileKey(floorNb[0].x, floorNb[0].y));
          ends.push({ x: e.x, y: e.y, dist: e.dist, from: deadEnd ? floorNb[0] : null });
        });

        // Reach first, carved hallway second, distance third.
        //
        // Reach is the guarantee - it is what says the stairs are down a hallway at all and
        // that the boss has its tiles to stand in - so nothing outranks it. It is capped
        // though, so once an anchor has that and then some, extra corridor stops competing and
        // the tie goes to whichever anchor carves the most of its own hallway: a carved run is
        // straight where a maze corridor of the same length wanders, and a straight one is a
        // hallway the player can see the stairs down instead of finding them round a corner.
        // Distance breaks what is left, which is the property the Exit had to begin with - and
        // it rarely gives up much, because the deepest dead ends sit against the edge of the
        // carve, which is exactly where the cells nobody used are.
        let reach = -1;
        best = null; bestRun = []; bestScore = -1; bestTier = tier;
        for (const end of ends) {
          const away = end.from ? { dx: end.x - end.from.x, dy: end.y - end.from.y } : null;
          const run = _growExitHall(end, MAZE.exitHallCells, away,
                                    new Set([_tileKey(end.x, end.y)]));
          const r = reachOf(end, run.length, gateKeys);
          const score = r * 1e6 + run.length * 1e3 + end.dist;
          if (score > bestScore) { bestScore = score; best = end; bestRun = run; reach = r; }
        }
        if (reach >= BOSS_TILES_FROM_EXIT) break;
      }

      // Give up the doors the chosen tier left behind. braidMaze has already run and treated
      // them as cut tiles, which only means it carved FEWER loops than it could have - dropping
      // a gate never invalidates a carve it refused to make. placeGatesAndSwitches has not run
      // at all yet, so these were never stamped and never got a switch.
      if (plan && bestTier < plan.gates.length) plan.gates.length = bestTier;

      exitRoom = best ? { x: best.x, y: best.y } : exitRoom;
      // Carve the hallway and walk the stairs out to the end of it. Every cell in the run was
      // solid wall a moment ago and only the connectors along the run come out with them, so
      // what this leaves is a corridor with exactly one opening - the way in - whose far end is
      // a dead end by construction. That is the guarantee placeEnemyMarkers leans on, now held
      // by the carve rather than by whatever shape the maze happened to end in.
      for (const step of bestRun) {
        MAP[step.wy][step.wx] = 0;
        MAP[step.y][step.x] = 0;
        exitRoom = { x: step.x, y: step.y };
      }
    }

    // Phase 3: stamp the planned doors and, for each, find one wall switch the player can
    // PROVABLY reach before that door (sequential gating). Guarantee: switch_k lies in the
    // region reachable with doors 0..k-1 open, so the player opens them in order and always
    // finishes. Braiding does not weaken this - it only ever adds corridors WITHIN a region,
    // which can make a switch easier to walk to but never moves it behind its own gate. Fills
    // doorList / switchList and stamps MAP (3 = closed door, 4 = switch OFF).
    function placeGatesAndSwitches(plan) {
      doorList = [];
      switchList = [];
      if (!plan) return;

      const gates = plan.gates;
      const N = gates.length;

      // The route the player actually walks now that the maze has loops in it. Every gate tile
      // is still a cut tile (see braidMaze), so this passes through all of them in order - but
      // it is no longer the pre-braid path, and it is THIS one the host scorer has to treat as
      // "the main route", or a lever scored as off-path could land on the corridor the player
      // was going to take anyway.
      const path = plan.path;
      const route = _bfsPath(startRoom, exitRoom) || path;
      const pathTiles = new Set(route.map((c) => _tileKey(c.x, c.y)));

      const usedCells = new Set();

      for (let k = 0; k < N; k++) {
        const g = gates[k];
        const d = g.tile;
        const seed = g.seed;

        // doors k..N-1 are still shut in this state; earlier doors are stamped MAP===3 and
        // therefore also block the flood, which only tightens the region (still safe).
        const blocked = new Set();
        for (let j = k; j < N; j++) blocked.add(_tileKey(gates[j].tile.x, gates[j].tile.y));
        const region = _flood(seed, (x, y) => MAP[y][x] === 0 && !blocked.has(_tileKey(x, y)));

        // Distance of every region tile from the door's approach tile (the path cell the
        // player stands on when the gate blocks them). Used to push the switch away from
        // the gate it opens - a lever mounted in the cell facing the door is no puzzle,
        // the player never has to leave the corridor to find it.
        const approach = g.approach;
        const doorDist = _flood(approach, (x, y) => MAP[y][x] === 0 && !blocked.has(_tileKey(x, y)));

        // host cell: an (odd,odd) floor tile in the region, not start/exit, unused, with a
        // solid wall to mount on. Wants it well clear of the door, off the start->exit path
        // (so reaching it costs a real detour) and ideally down a dead end.
        let best = null, bestScore = -1;
        const pickHost = (minDoorDist) => {
          best = null; bestScore = -1;
          region.forEach((e) => {
            if (e.x % 2 !== 1 || e.y % 2 !== 1) return;
            if (e.x === startRoom.x && e.y === startRoom.y) return;
            if (e.x === exitRoom.x && e.y === exitRoom.y) return;
            if (usedCells.has(_tileKey(e.x, e.y))) return;
            const dEntry = doorDist.get(_tileKey(e.x, e.y));
            if (!dEntry || dEntry.dist < minDoorDist) return;
            let wallNb = 0, floorNb = 0;
            for (const dl of _ORTHO) {
              const nx = e.x + dl.dx, ny = e.y + dl.dy;
              if (ny < 0 || ny >= MAP_HEIGHT || nx < 0 || nx >= MAP_WIDTH) continue;
              if (MAP[ny][nx] === 1) wallNb++;
              else if (MAP[ny][nx] === 0) floorNb++;
            }
            if (wallNb === 0) return;
            const dd = dEntry.dist;
            const offPath = !pathTiles.has(_tileKey(e.x, e.y));
            const score = (offPath ? 60 : 0)                  // side passage, not the main route
                        + (floorNb <= 1 ? 25 : 0)             // dead end
                        + (dd <= 20 ? 40 : 0)                 // far, but not a slog back to the gate
                        + Math.min(dd, 20) * 4
                        + e.dist;                             // tie-break: deeper from the seed
            if (score > bestScore) { bestScore = score; best = { x: e.x, y: e.y }; }
          });
        };

        // 6 tiles = three cells clear of the gate. Relax only when the reachable region is
        // too cramped to honour it, so tiny mazes still get a solvable switch.
        pickHost(6);
        if (!best) pickHost(4);
        if (!best) pickHost(2);
        if (!best) pickHost(0);

        // fallback: a path cell strictly between the seed and this door, furthest from the
        // door first for the same reason.
        if (!best) {
          for (let t = g.lowIdx; t <= g.hiIdx; t++) {
            const c = path[t];
            if (c.x % 2 !== 1 || c.y % 2 !== 1) continue;
            if (usedCells.has(_tileKey(c.x, c.y))) continue;
            let wallNb = 0;
            for (const dl of _ORTHO) {
              const nx = c.x + dl.dx, ny = c.y + dl.dy;
              if (ny >= 0 && ny < MAP_HEIGHT && nx >= 0 && nx < MAP_WIDTH && MAP[ny][nx] === 1) wallNb++;
            }
            if (wallNb > 0) { best = { x: c.x, y: c.y }; break; }
          }
        }
        if (!best) continue;                               // cannot gate safely -> skip door

        // wall tile for the switch: a solid neighbour of the host cell. Prefer the wall
        // opposite the single entrance (the "back wall" of a dead end), and prefer non-border.
        const floorDirs = [];
        for (const dl of _ORTHO) {
          const nx = best.x + dl.dx, ny = best.y + dl.dy;
          if (ny >= 0 && ny < MAP_HEIGHT && nx >= 0 && nx < MAP_WIDTH && MAP[ny][nx] === 0) floorDirs.push(dl);
        }
        const wallCandidates = [];
        for (const dl of _ORTHO) {
          const nx = best.x + dl.dx, ny = best.y + dl.dy;
          if (ny < 0 || ny >= MAP_HEIGHT || nx < 0 || nx >= MAP_WIDTH) continue;
          if (MAP[ny][nx] !== 1) continue;
          const border = (nx === 0 || ny === 0 || nx === MAP_WIDTH - 1 || ny === MAP_HEIGHT - 1);
          const opposite = floorDirs.length === 1 &&
            dl.dx === -floorDirs[0].dx && dl.dy === -floorDirs[0].dy;
          wallCandidates.push({ x: nx, y: ny, rank: (opposite ? 0 : 1) + (border ? 2 : 0) });
        }
        if (!wallCandidates.length) continue;
        wallCandidates.sort((p, q) => p.rank - q.rank);
        const wall = wallCandidates[0];

        MAP[d.y][d.x] = 3;
        MAP[wall.y][wall.x] = 4;

        // Doorway orientation was worked out by planGates from the two cells this connector
        // joins - see the `axis` note there for what it means and why braiding cannot change it.
        doorList.push({ x: d.x, y: d.y, index: k, opened: false, axis: g.axis });
        switchList.push({
          x: wall.x, y: wall.y, cellX: best.x, cellY: best.y, doorIndex: k, on: false
        });
        usedCells.add(_tileKey(best.x, best.y));
      }
    }

        // ==========================================
    // AUTHENTIC 3DMAZE GENERATOR (GOLDEN STANDARD - EXACT TILES)
    // ==========================================
    // Backstop on generateAuthentic3DMaze's reroll - see the note there.
    const MAZE_BUILD_ATTEMPTS = 25;
    function generateAuthentic3DMaze(numGrids = DIFFICULTIES.medium.grids) {
      numGrids = Math.max(10, Math.min(MAX_GRIDS, numGrids));

      // Calculate target cells to reach exactly (or close to) numGrids total walkable tiles.
      // Since total tiles = cells + (cells - 1) = 2 * cells - 1
      const targetCells = Math.max(2, Math.ceil((numGrids + 1) / 2));

      // A bounding box large enough to let the DFS wander organically. It comes out about 1.4x
      // the cells the carve will actually use, and the leftovers are not slack: they are the
      // rock relocateExit tunnels the stairs' hallway through, which is why that hallway costs
      // nothing off `grids`.
      const cellCols = Math.max(3, Math.ceil(Math.sqrt(targetCells * 1.5)));
      const cellRows = Math.max(3, Math.ceil(targetCells / cellCols) + 1);

      MAP_WIDTH = cellCols * 2 + 1;
      MAP_HEIGHT = cellRows * 2 + 1;

      lanternList = [];
      doorList = [];
      switchList = [];

      // The boss is only the last fight if a door stands in front of it, and nothing up to
      // here promises one. relocateExit gives doors up when the region past them has no room
      // for the stairs' hallway - and Easy only ever plans ONE door, so giving it up leaves the
      // boss in the spawn's own region, reachable as the first or second fight of the run.
      // Measured over 8000 Easy mazes that is ~0.5% of them, and a bigger maze is no cure: the
      // rate swings with the grid's shape rather than its size (0.1% at 36 grids, 1.0% at 52)
      // and only reaches zero past Medium. So check the finished maze and carve a new one when
      // it came out that way.
      //
      // The stairs stand in for the boss here, which lets the check run before the lantern bake
      // and the markers rather than after them: the boss stands in the stairs' hallway, and
      // that hallway has no door in it, so one is reachable without a door exactly when the
      // other is. A maze too short for planGates to gate at all (gatePlan null - none of 112000
      // measured at 33 to 111 grids were) is let through, since no reroll would give it
      // a door. The attempt cap is only a backstop; at ~0.5% a second reroll is already rare.
      //
      // The same loop throws away a carve whose exit hallway leaves the boss nowhere to stand:
      // findExitGuardSpot wants a straight run of five to put the guard in the middle of, and
      // about 1% of hallways bend or run out before they offer one. That is a property of where
      // relocateExit could tunnel rather than of the maze the player walks, so a fresh carve
      // fixes it. Measured over 1200 dungeons a side it rerolls 1.4% of Easy carves, 1.3% of
      // Medium and 0.9% of Hard, none of them ever ran out of attempts, and the boss came out
      // with its five tiles on every one of the 3600.
      for (let attempt = 1; ; attempt++) {
        const gatePlan = carveAndGateMaze(cellRows, cellCols, targetCells);
        const reachable = _flood(startRoom, (x, y) => MAP[y][x] === 0);
        const ungated = gatePlan && reachable.has(_tileKey(exitRoom.x, exitRoom.y));
        const cramped = !findExitGuardSpot().roomy;
        const why = ungated ? 'boss reachable without a door' : 'no straight hallway for the boss';
        if (!ungated && !cramped) break;
        if (attempt >= MAZE_BUILD_ATTEMPTS) {
          console.info(`[maze] ${why} after ${attempt} attempts - keeping it`);
          break;
        }
        console.info(`[maze] attempt ${attempt}: ${why} - carving a new maze`);
      }

      // Add Lanterns to Walls - never beside a door or switch (see _nearGateOrSwitch above).
      for (let y = 1; y < MAP_HEIGHT - 1; y++) {
        for (let x = 1; x < MAP_WIDTH - 1; x++) {
          if (MAP[y][x] === 1) {
            const hasAdjacentFloor = (MAP[y-1][x] === 0 || MAP[y+1][x] === 0 || MAP[y][x-1] === 0 || MAP[y][x+1] === 0);
            if (hasAdjacentFloor && (x + y) % 3 === 0 && !_nearGateOrSwitch(x, y)) {
              MAP[y][x] = 2;
              lanternList.push({ x, y });
            }
          }
        }
      }

      // The lantern set is final, so bake its light field now - once - instead of re-summing
      // it per pixel every frame. See buildLightMaps.
      buildLightMaps();

      passagesList = [];
      for (let y = 1; y < MAP_HEIGHT - 1; y++) {
        for (let x = 1; x < MAP_WIDTH - 1; x++) {
          if (MAP[y][x] === 0) {
            passagesList.push({ x, y });
          }
        }
      }

      // Needs the finished passagesList - and the finished gates, since a marker parked on a
      // door tile would be unreachable until its switch was thrown.
      placeEnemyMarkers();

      // GUARANTEE player spawns facing the OPEN corridor (never facing a wall!)
      let spawnDir = 1;
      if (MAP[startRoom.y] && MAP[startRoom.y][startRoom.x + 1] === 0) spawnDir = 1;
      else if (MAP[startRoom.y + 1] && MAP[startRoom.y + 1][startRoom.x] === 0) spawnDir = 2;
      else if (MAP[startRoom.y] && MAP[startRoom.y][startRoom.x - 1] === 0) spawnDir = 3;
      else if (MAP[startRoom.y - 1] && MAP[startRoom.y - 1][startRoom.x] === 0) spawnDir = 0;

      player.gridX = startRoom.x;
      player.gridY = startRoom.y;
      player.dirIndex = spawnDir;
      player.posX = startRoom.x + 0.5;
      player.posY = startRoom.y + 0.5;
      player.angle = dirToAngle(spawnDir);
      player.isAnimating = false;

      visitedTiles.clear();
      visitedTiles.add(`${startRoom.x},${startRoom.y}`);
      totalMoves = 0;
      queuedAction = null;

      if (mapProgressBadge) {
        mapProgressBadge.textContent = `${visitedTiles.size}/${passagesList.length} Tiles`;
      }
    }

    // One carve of the maze proper - the tree, its gates, its loops and the stairs' hallway,
    // in the order the note below explains - onto a fresh MAP of the size the caller already
    // set. Returns the gate plan (null when the maze was too short to gate), which
    // generateAuthentic3DMaze uses to decide whether this carve is one it keeps.
    function carveAndGateMaze(cellRows, cellCols, targetCells) {
      MAP = Array(MAP_HEIGHT).fill(0).map(() => Array(MAP_WIDTH).fill(1));

      const visitedCells = Array(cellRows).fill(0).map(() => Array(cellCols).fill(false));
      const stack = [];
      
      const startR = Math.floor(cellRows / 2);
      const startC = Math.floor(cellCols / 2);
      const startCell = { r: startR, c: startC };
      
      visitedCells[startR][startC] = true;
      MAP[startR * 2 + 1][startC * 2 + 1] = 0;
      stack.push(startCell);

      let visitedCount = 1;
      let maxDist = 0;
      let furthestCell = { r: startR, c: startC };
      const distances = Array(cellRows).fill(0).map(() => Array(cellCols).fill(0));

      while (stack.length > 0 && visitedCount < targetCells) {
        // Growing-tree selection (see MAZE.branchChance). Always taking the newest frontier
        // cell IS the recursive backtracker; taking a random one some of the time keeps several
        // corridors advancing at once, so the finished maze has junctions spread through it
        // rather than one committed passage that only forks when it hits a wall.
        const pick = (stack.length > 1 && Math.random() < MAZE.branchChance)
          ? Math.floor(Math.random() * stack.length)
          : stack.length - 1;
        const current = stack[pick];
        const neighbors = [];

        const deltas = [
          { dr: -1, dc: 0 },
          { dr: 1, dc: 0 },
          { dr: 0, dc: -1 },
          { dr: 0, dc: 1 }
        ];

        for (const d of deltas) {
          const nr = current.r + d.dr;
          const nc = current.c + d.dc;
          if (nr >= 0 && nr < cellRows && nc >= 0 && nc < cellCols && !visitedCells[nr][nc]) {
            neighbors.push({ r: nr, c: nc, dr: d.dr, dc: d.dc });
          }
        }

        if (neighbors.length > 0) {
          const next = neighbors[Math.floor(Math.random() * neighbors.length)];
          const wallY = current.r * 2 + 1 + next.dr;
          const wallX = current.c * 2 + 1 + next.dc;
          const nextY = next.r * 2 + 1;
          const nextX = next.c * 2 + 1;

          MAP[wallY][wallX] = 0;
          MAP[nextY][nextX] = 0;

          visitedCells[next.r][next.c] = true;
          distances[next.r][next.c] = distances[current.r][current.c] + 1;
          visitedCount++;

          if (distances[next.r][next.c] > maxDist) {
            maxDist = distances[next.r][next.c];
            furthestCell = { r: next.r, c: next.c };
          }

          stack.push({ r: next.r, c: next.c });
        } else {
          stack.splice(pick, 1);          // not necessarily the top any more - see `pick` above
        }
      }

      startRoom = { x: startC * 2 + 1, y: startR * 2 + 1 };
      exitRoom = { x: furthestCell.c * 2 + 1, y: furthestCell.r * 2 + 1 };

      // Gating, loop-carving and the stairs' hallway are interleaved, and the order is
      // load-bearing:
      //   planGates()  picks the door tiles while the maze is still a tree and the start->exit
      //                route is therefore unique - which is what "evenly spaced along it" means.
      //   braidMaze()  adds the loops that make the maze multicursal, refusing any carve that
      //                would join two different gate regions, so every planned door stays a
      //                mandatory cut tile rather than something you can walk around.
      //   relocateEx.. re-picks the Exit on the braided map and carves it the hallway it sits
      //                at the end of. It is the last thing to touch corridor layout, and the
      //                only one allowed to: braiding is already done, so a hallway carved here
      //                cannot have a shortcut opened into it afterwards. It can also hand back
      //                a door - see the gate tiers in there - which is safe precisely because
      //                braidMaze has already run and refusing carves it might have made is not
      //                something dropping a gate can undo.
      //   placeGates.. stamps the doors that survived and hunts down switch hosts on the
      //                FINISHED map, so a lever is scored against the route the player really
      //                takes - hallway included.
      // All four run BEFORE the lantern pass (which only touches MAP===1, so it skips our
      // door/switch tiles) and BEFORE passagesList is built (so a closed door is correctly
      // excluded from the walkable-tile count, and the loop and hallway tiles are correctly
      // included).
      const gatePlan = planGates();
      const gateRegions = braidMaze(cellRows, cellCols, gatePlan);
      relocateExit(gatePlan, gateRegions);
      placeGatesAndSwitches(gatePlan);
      return gatePlan;
    }

    // Scatter the dungeon's foes over its corridors.
    //
    // Rules, in the order they matter:
    //   - never the spawn tile, never the exit tile (the exit ends the run the moment it is
    //     stepped on, so a fight there could never resolve), and nothing within 2 tiles of the
    //     spawn - the player gets a corridor's worth of dungeon before the first ambush.
    //   - markers keep 2 tiles between them, so a cleared stretch stays cleared and a corridor
    //     never turns into a gauntlet of three back-to-back fights.
    //   - the BOSS does not roam, and there is only ever ONE of it. relocateExit carves the
    //     stairs their own hallway and leaves them at the dead end of it, so a single guard
    //     standing in that hallway is unavoidable: the last thing between the player and the
    //     stairs is always the dread foe. Everything that roams is a walker or a flyer.
    //   - nothing else is allowed into the stretch of hallway between the boss and the stairs.
    //     Spacing alone does not cover that - a roamer on the stairs' doorstep is a full three
    //     tiles from a boss standing three back, so it passes the spacing check while making a
    //     liar of the rule above - so those tiles are struck off the candidate list outright.
    // Density is ~1 foe per 6 tiles, floored at 4 so even the smallest maze is worth fighting
    // through, capped at 14 so a huge one doesn't become a slog. The guard counts towards it.
    const MARKER_MIN_SPACING = 2;
    // How far back down the exit hallway the boss stands, in tiles. A cell is two tiles wide
    // (cell, connector, cell), so 3 lands the guard on the connector between the two cells
    // nearest the stairs - deep enough into the corridor that the player fights it with hallway
    // both in front and behind, rather than backing into the stairwell mid-swing, and far
    // enough that beating it still leaves the walk down to the stairs to make. MAZE.exitHallCells
    // is what guarantees there are three unbranching tiles back there to count off, and
    // findExitGuardSpot is free to count off more than three when the third tile is a corner.
    const BOSS_TILES_FROM_EXIT = 3;
    // How far back the walk is allowed to go looking for a tile that satisfies the rule below.
    // Only ever used when the tile three back does not - a hallway that turns a corner there -
    // and the walk still stops at the first fork, so a deeper guard is no less unavoidable.
    const BOSS_MAX_TILES_FROM_EXIT = 8;

    // The boss never stands on a corner, and never in a stub: it stands in the middle of a
    // straight run of five, with two floor tiles to its left AND right, or two above AND below.
    // A corner puts a wall a step from its shoulder, which on a foe markerScaleFor draws half
    // again as large as anything else reads as the boss wedged into the masonry, and it leaves
    // the player nowhere to sidestep the charge - the one attack that takes the whole telegraph
    // bar. Five tiles of hallway is the room that fight wants.
    function bossHasHallwayRoom(x, y) {
      const open = (ax, ay) => ay > 0 && ay < MAP_HEIGHT - 1 && ax > 0 && ax < MAP_WIDTH - 1
                               && MAP[ay][ax] === 0;
      const run = (dx, dy) => open(x + dx, y + dy) && open(x + dx * 2, y + dy * 2);
      return (run(-1, 0) && run(1, 0)) || (run(0, -1) && run(0, 1));
    }

    // Walks the exit hallway back from the stairs and says where the one guard stands.
    //
    // The guard stands BOSS_TILES_FROM_EXIT tiles back rather than on the stairs' doorstep, so
    // the fight happens in the corridor with the stairwell in sight at the end of it, and
    // beating the boss still leaves the last stretch to walk instead of dropping the player
    // into the stairs out of its reach.
    //
    // Walked one tile at a time, and it stops at the first fork. Every step back is only
    // unavoidable while it is still the ONLY way through: past a junction the player could
    // round the boss and reach the stairs by the other branch. relocateExit sizes the hallway
    // off the same constant, so the walk always has its three tiles to give - measured over 1200
    // dungeons a side, the shortest it ever ran was four, and on most it ran the full eight -
    // and the early exit is what keeps the guard unavoidable rather than merely deep if that
    // ever stops being true.
    //
    // It carries on PAST the third tile, as far as BOSS_MAX_TILES_FROM_EXIT, so every tile the
    // guard could legally stand on is on the table before one is picked. bossHasHallwayRoom
    // then does the picking: the shallowest tile at or past BOSS_TILES_FROM_EXIT with a straight
    // run of five around it. On a hallway that carved straight that is the third tile itself,
    // leaving the fight exactly where it has always been; one that turned a corner there hands
    // the boss the next tile down that did not, rather than standing it in the corner. Measured
    // over 1200 dungeons a side, the guard lands on the third or fourth tile 54% of the time on
    // Easy, 62% on Medium and 67% on Hard, and six or eight tiles back on most of the rest.
    //
    // Reads MAP directly and counts only floor - a door is not somewhere a guard is stood - so
    // the same question can be asked twice: once by generateAuthentic3DMaze, to throw away a
    // carve that left the boss no hallway at all, and once by placeEnemyMarkers to place it.
    // Returns { spot, hall, roomy }: the guard's tile, the stretch from the stairs back through
    // it that nothing else may stand in, and whether that tile satisfies the rule or is the
    // last-ditch pick below.
    function findExitGuardSpot() {
      const open = (x, y) => y > 0 && y < MAP_HEIGHT - 1 && x > 0 && x < MAP_WIDTH - 1
                             && MAP[y][x] === 0;
      const isStart = (p) => p.x === startRoom.x && p.y === startRoom.y;
      const nbrs = (p) => _ORTHO.map((d) => ({ x: p.x + d.dx, y: p.y + d.dy }))
        .filter((q) => open(q.x, q.y));
      // The spawn tile is excluded on the off chance a small maze puts the two next to each
      // other - being ambushed by the boss before taking a step is not a fight, it is a wall.
      const approaches = nbrs(exitRoom).filter((p) => !isStart(p));
      // There is exactly one of these: the stairs sit at the dead end of the hallway
      // relocateExit carved them, so there is one way in by construction. The sort below is
      // belt and braces for the degenerate map where that carve found nowhere to go at all -
      // the one guard then takes the approach the player reaches FIRST, the way in they will
      // actually walk, rather than a random one. Doors count as passable there for the same
      // reason relocateExit floods with them open: the player will have opened them by the
      // time they are this deep.
      if (approaches.length > 1) {
        const fromStart = _flood(startRoom, (x, y) => MAP[y][x] === 0 || MAP[y][x] === 3);
        const walkDist = (p) => {
          const e = fromStart.get(_tileKey(p.x, p.y));
          return e ? e.dist : Infinity;
        };
        approaches.sort((a, b) => walkDist(a) - walkDist(b));
      }

      const walked = [];
      const seen = new Set([_tileKey(exitRoom.x, exitRoom.y)]);
      if (approaches.length) {
        let cur = approaches[0];
        walked.push(cur);
        seen.add(_tileKey(cur.x, cur.y));
        for (let step = 2; step <= BOSS_MAX_TILES_FROM_EXIT; step++) {
          const onward = nbrs(cur).filter((q) => !seen.has(_tileKey(q.x, q.y)) && !isStart(q));
          if (onward.length !== 1) break;      // fork, or nothing behind it - the hallway ends
          cur = onward[0];
          walked.push(cur);
          seen.add(_tileKey(cur.x, cur.y));
        }
      }

      // walked[i] is i+1 tiles from the stairs. The shallowest roomy tile at or past the usual
      // depth wins; failing that the deepest roomy tile IN FRONT of it, for the ~2% of hallways
      // whose only straight five is the stretch nearest the stairs. Standing the guard two back
      // is closer than the fight wants to be, but it is still the corridor, still the one way
      // in, and still five tiles of room - all of which a corner three back is not.
      let spot = null, shallowRoomy = null;
      for (let i = 0; i < walked.length; i++) {
        if (!bossHasHallwayRoom(walked[i].x, walked[i].y)) continue;
        if (i >= BOSS_TILES_FROM_EXIT - 1) { spot = walked[i]; break; }
        shallowRoomy = walked[i];
      }
      if (!spot) spot = shallowRoomy;
      const roomy = !!spot;
      // Last ditch, for a maze with no straight five anywhere behind the stairs:
      // generateAuthentic3DMaze rerolls those, but its attempt cap can run out - and an
      // unavoidable guard in a bend still beats no guard at all.
      if (!spot && walked.length) spot = walked[Math.min(BOSS_TILES_FROM_EXIT, walked.length) - 1];

      // Everything from the stairs back to and including the guard's own tile is the guarded
      // stretch. Tiles the walk explored BEHIND it are not part of it - they are ordinary
      // corridor, and a roamer is welcome to them (MARKER_MIN_SPACING keeps it off the boss's
      // shoulder).
      const hall = [{ x: exitRoom.x, y: exitRoom.y }];
      for (const p of walked) {
        hall.push(p);
        if (p === spot) break;
      }
      return { spot, hall, roomy };
    }

    function placeEnemyMarkers() {
      enemyMarkers = [];
      activeMarker = null;
      if (!passagesList.length) return;

      const target = Math.max(4, Math.min(14, Math.round(passagesList.length * 0.16)));
      const far = (a, bx, by) => Math.abs(a.x - bx) + Math.abs(a.y - by);
      const push = (x, y, variant) => {
        const m = { x, y, variant, alive: true, phase: Math.random() * Math.PI * 2 };
        enemyMarkers.push(m);
        return m;
      };

      // Walking distance from the spawn tile, doors counted as passable (the player will have
      // opened them by the time they are out this far). Used below to order the roamers, so the
      // ones the player meets FIRST can be held back to the two plain foes.
      const fromStart = _flood(startRoom, (x, y) => MAP[y][x] === 0 || MAP[y][x] === 3);
      const walkDist = (p) => {
        const e = fromStart.get(_tileKey(p.x, p.y));
        return e ? e.dist : Infinity;
      };

      // --- The exit guard. ONE boss, because relocateExit hands us an Exit that is a dead end:
      // a single corridor reaches the stairs, so a single foe standing in it cannot be walked
      // around. It is visible from down that corridor because markerScaleFor draws it half
      // again as large as anything else. findExitGuardSpot walks that corridor and picks the
      // tile - see it for where in the hallway the boss ends up and why.
      const guard = findExitGuardSpot();
      const exitHallTiles = new Set(guard.hall.map((p) => _tileKey(p.x, p.y)));
      if (guard.spot) push(guard.spot.x, guard.spot.y, 'boss');

      // --- The roaming foes fill the rest of the maze around them. exitHallTiles is every tile
      // from the stairs back to and including the boss's, and none of it is up for grabs: a
      // roamer in there would be the last thing standing between the player and the stairs
      // instead of the boss, which is the one thing the exit hallway exists to prevent.
      const candidates = passagesList.filter(p =>
        !(p.x === startRoom.x && p.y === startRoom.y) &&
        !exitHallTiles.has(_tileKey(p.x, p.y)) &&
        far(p, startRoom.x, startRoom.y) > 2
      );
      _shuffle(candidates);

      // The roaming mix, applied to everything PAST the opening stretch below. The lone walker
      // stays the most common thing in a corridor; the lone flyer and the two packs split the
      // rest, so the back half of a dungeon of a dozen markers runs roughly four walkers, three
      // flyers, three swarms and two wings.
      //
      // This runs the INSTANT "Create" is clicked - generateAuthentic3DMaze() is synchronous
      // and happens well before the ComfyUI bundle (and its walker/flyer art) comes back, so
      // enemyVariantImgs here is either empty (a session's first dungeon) or still holding the
      // PREVIOUS dungeon's sprites. It used to gate swarmer/circler on enemyFramesFor(k) right
      // here, "only let a pack roam if its base sprite exists" - which on a first dungeon is
      // always false, silently dropping both out of the bag before a single marker was placed.
      // Walker/flyer never had that problem because nothing gated them on sprite-readiness at
      // all - the sprite swap-in just catches up by the time the player can reach a marker, and
      // v6_krea (the only engine mode left) always ships all three base variants. Packs get the
      // same free ride: pickEnemyVariant() re-checks enemyFramesFor() at the moment a fight
      // actually starts - long after the bundle has landed - and downgrades a pack to its full
      // size base variant there if it ever genuinely has no sprite to recolour, so no readiness
      // check belongs here.
      const ROAM_WEIGHTS = { walker: 4, flyer: 3, swarmer: 3, circler: 2 };
      const roamBag = [];
      for (const [k, w] of Object.entries(ROAM_WEIGHTS)) {
        for (let i = 0; i < w; i++) roamBag.push(k);
      }

      // Positions first, variants second. Which foe a marker turns out to be depends on how
      // FAR ALONG it sits, and that ordering only exists once every roamer has a tile.
      const roamers = [];
      for (const p of candidates) {
        if (enemyMarkers.length >= target) break;
        if (enemyMarkers.some(m => far(p, m.x, m.y) < MARKER_MIN_SPACING)) continue;
        roamers.push(push(p.x, p.y, null));
      }

      // --- The opening stretch. Every foe the player can reach from the spawn WITHOUT passing
      // a locked door is one of the two PLAIN variants only - one walker, one flyer - with the
      // packs (swarm, wing) held back until past the first door. Rolling the full bag from the
      // very first marker meant a dungeon could open on a three-runt swarm (~10 HP/s of incoming
      // damage, no guard to punish and no retreat) before the player had fought anything at
      // all, which reads as the dungeon being broken rather than hard. Meeting the lone walker
      // first teaches its punish window, and the lone flyer teaches the swoop; the swarm and
      // the wing are then variations on two things already learned.
      //
      // This used to hold back a fixed 3-6 foes by walking distance, but on a small maze that
      // count could cover every marker in the dungeon, so a whole run would show nothing but
      // the two plain foes. Tying it to the first door instead: the packs always turn up once
      // there IS a door behind the player, and no sooner. A maze too small for planGates to
      // gate at all (doorList empty) has no "first door", so it eases only the very first foe -
      // those tiny runs still get pack variety.
      //
      // Doors are MAP tile 3 here (placeGatesAndSwitches has already stamped them). preDoorReach
      // is every floor tile reachable from the spawn over MAP===0 only - region 0, the pocket
      // in front of the first gate.
      const preDoorReach = _flood(startRoom, (x, y) => MAP[y][x] === 0);
      const hasDoors = doorList.length > 0;

      // Distance order, so the walker/flyer deal below lands the walker on the nearest foe and
      // so the eased set resolves as a clean prefix of the roamer list. Manhattan distance
      // breaks ties. The exit guard is not in here: it was pushed before this and is a boss by
      // definition, at the far end anyway.
      roamers.sort((a, b) => (walkDist(a) - walkDist(b)) ||
                             (far(a, startRoom.x, startRoom.y) - far(b, startRoom.x, startRoom.y)));

      const easeSet = new Set(roamers.filter((m, i) =>
        i === 0 || (hasDoors && preDoorReach.has(_tileKey(m.x, m.y)))));

      // The opening foes are DEALT, not rolled: split the eased count by the same 4:3
      // walker/flyer ratio the roaming bag uses, then shuffle. Rolling them independently would
      // let a run of luck make the whole opening walkers, which is exactly the "you never saw a
      // flyer before the wing" case this is meant to prevent. The very first one is pinned to
      // the walker regardless - it is the foe every other one is a variation on.
      // Capped at easeCount - 1 (once there's more than one) rather than a bare ceil: on a
      // small Easy maze easeCount often lands on exactly 2 (one door, most of the maze in
      // front of it), and ceil(2*4/7) = 2 dealt both of them walker - zero flyers - which is
      // the "every enemy is the same default walking enemy" case. Capping guarantees a flyer
      // shows up as soon as there is a second eased foe to give one to.
      const easeCount = easeSet.size;
      const easeWalkers = easeCount <= 1 ? easeCount
        : Math.min(Math.ceil(easeCount * 4 / 7), easeCount - 1);
      const easeDeal = [];
      for (let i = 0; i < easeCount; i++) easeDeal.push(i < easeWalkers ? 'walker' : 'flyer');
      _shuffle(easeDeal);
      if (easeDeal.length) {
        const w = easeDeal.indexOf('walker');
        if (w > 0) { easeDeal[w] = easeDeal[0]; easeDeal[0] = 'walker'; }
      }

      let dealt = 0;
      roamers.forEach((m) => {
        m.variant = easeSet.has(m)
          ? easeDeal[dealt++]
          : roamBag[Math.floor(Math.random() * roamBag.length)];
      });
      updateProgressionHUD();
    }

    // The sprite a marker shows in the corridor: that variant's idle frame when the bundle
    // generated one, else whatever single enemy sprite the mode shipped. Null falls through to
    // the procedural sigil in drawWorldEnemies.
    function markerFrameFor(variant) {
      const set = enemyFramesFor(variant);
      if (set && set.idle && set.idle.complete && set.idle.naturalWidth > 0) return set.idle;
      const fallback = enemySpriteFrames[0];
      if (fallback && fallback.complete && fallback.naturalWidth > 0) return fallback;
      return null;
    }

    // ==========================================
    // 3D RAYCASTER RENDERER + 3D EXIT SIGN
    // ==========================================
    function render3D() {
      if (!wallTexture || !ceilingTexture || !floorTexture) return;

      const fov = Math.PI / 3;
      const halfFov = fov / 2;
      const pAngle = player.angle;

      const dirX = Math.cos(pAngle);
      const dirY = Math.sin(pAngle);

      // The camera sits back from the player's cell centre rather than on it. Movement is grid
      // based, so a faced wall would otherwise always be exactly 0.5 away and tower over the
      // screen. Setting the camera back pushes that wall to ~0.9 without shortening the walls
      // themselves - which is what keeps corridors looking tall while still leaving ceiling and
      // floor visible when the player is right up against something. Shortening walls alone
      // (the first attempt) bought the headroom at the cost of a squashed, crawlspace-looking
      // corridor. The camera stays inside the current cell, so raycasting is unaffected.
      const posX = player.posX - dirX * CAMERA_SETBACK;
      const posY = player.posY - dirY * CAMERA_SETBACK;
      const planeX = -dirY * Math.tan(halfFov);
      const planeY = dirX * Math.tan(halfFov);

      // Wall Casting
      //
      // Walls go FIRST, before the floor and ceiling, which is the reverse of how this used to
      // read. The old order cast every one of the 76,800 floor/ceiling pixels and then painted
      // walls straight over the top of them - in a corridor that is most of the screen thrown
      // away, shaded and texture-sampled for nothing. Casting walls first lets each column
      // record the band it covers (wallTop/wallBot below), so the floor/ceiling pass can skip
      // those pixels outright. The two passes write disjoint pixels, so the visible result is
      // identical; we simply stop drawing everything at once.
      for (let x = 0; x < screenWidth; x++) {
        const cameraX = (2 * x) / screenWidth - 1;
        const rayDirX = dirX + planeX * cameraX;
        const rayDirY = dirY + planeY * cameraX;

        let mapX = Math.floor(posX);
        let mapY = Math.floor(posY);

        let sideDistX, sideDistY;
        const deltaDistX = Math.abs(1 / (rayDirX === 0 ? 1e-6 : rayDirX));
        const deltaDistY = Math.abs(1 / (rayDirY === 0 ? 1e-6 : rayDirY));
        let perpWallDist;

        let stepX, stepY;
        let hit = 0;
        let side = 0;

        if (rayDirX < 0) {
          stepX = -1;
          sideDistX = (posX - mapX) * deltaDistX;
        } else {
          stepX = 1;
          sideDistX = (mapX + 1.0 - posX) * deltaDistX;
        }

        if (rayDirY < 0) {
          stepY = -1;
          sideDistY = (posY - mapY) * deltaDistY;
        } else {
          stepY = 1;
          sideDistY = (mapY + 1.0 - posY) * deltaDistY;
        }

        while (hit === 0) {
          if (sideDistX < sideDistY) {
            sideDistX += deltaDistX;
            mapX += stepX;
            side = 0;
          } else {
            sideDistY += deltaDistY;
            mapY += stepY;
            side = 1;
          }
          if (mapX < 0 || mapX >= MAP_WIDTH || mapY < 0 || mapY >= MAP_HEIGHT) {
            hit = 1;
            break;
          }
          // 6 is an opened gate: walkable and see-through, so the ray passes it and the
          // doorway is drawn as a sprite in the open-gate pass below.
          const cell = MAP[mapY][mapX];
          if (cell > 0 && cell !== 6) hit = cell;
        }

        if (side === 0) perpWallDist = (mapX - posX + (1 - stepX) / 2) / rayDirX;
        else perpWallDist = (mapY - posY + (1 - stepY) / 2) / rayDirY;

        perpWallDist = Math.max(0.1, perpWallDist);
        zBuffer[x] = perpWallDist;

        // True perspective, just with shorter walls - see WALL_HEIGHT.
        const lineHeight = Math.floor((screenHeight * WALL_HEIGHT) / perpWallDist);
        let drawStart = Math.floor(-lineHeight / 2 + screenHeight / 2);
        let drawEnd = Math.floor(lineHeight / 2 + screenHeight / 2);

        const clampedStart = Math.max(0, drawStart);
        const clampedEnd = Math.min(screenHeight - 1, drawEnd);

        // What the floor/ceiling pass must not bother drawing. When the band comes out empty
        // (a wall so distant it projects to under a pixel) clampedStart ends up above
        // clampedEnd, and the `y >= top && y <= bot` test below simply never matches.
        wallTop[x] = clampedStart;
        wallBot[x] = clampedEnd;

        if (clampedStart > clampedEnd) continue;

        let wallX;
        if (side === 0) wallX = posY + perpWallDist * rayDirY;
        else wallX = posX + perpWallDist * rayDirX;
        wallX -= Math.floor(wallX);

        let texX = Math.floor(wallX * TEX_SIZE);
        if (side === 0 && rayDirX > 0) texX = TEX_SIZE - texX - 1;
        if (side === 1 && rayDirY < 0) texX = TEX_SIZE - texX - 1;

        let wallTexToUse = wallTexture;
        if (hit === 2 && wallLanternTexture) wallTexToUse = wallLanternTexture;
        else if (hit === 3 && doorTexture) wallTexToUse = doorTexture;
        else if (hit === 4 || hit === 5) {
          // Only the face looking into the switch's host cell wears the fixture - see
          // _switchFaceHit. The other three faces fall through to the plain wall texture.
          const swTex = hit === 4 ? switchWallOffTexture : switchWallOnTexture;
          if (swTex && _switchFaceHit(mapX, mapY, side, stepX, stepY)) wallTexToUse = swTex;
        }
        const wallData = wallTexToUse.data;

        // One tap into the baked field instead of a walk down lanternList - see buildLightMaps.
        const wallWorldX = side === 0 ? mapX : (posX + perpWallDist * rayDirX);
        const wallWorldY = side === 1 ? mapY : (posY + perpWallDist * rayDirY);
        const wallLanternLight = sampleLight(wallLightMap, wallWorldX, wallWorldY);

        const sideShade = side === 1 ? 0.82 : 1.0;
        const distShade = 1.0 / (1.0 + perpWallDist * 0.38);
        const lanternSelfGlow = (hit === 2) ? 0.35 : 0;
        // No switchGlow term here - an ON switch is shaded like any other wall tile. Its
        // inverted fixture colours are the only difference from OFF, and they are baked into
        // the texture (buildSwitchWallTextures), so the lighting maths never has to know
        // which state a switch is in.
        const finalShade = Math.min(1.0, (sideShade * distShade) + wallLanternLight + lanternSelfGlow);

        // Constant down the whole column, so hoisted out of the per-pixel loop.
        const addR = wallLanternLight * 35;
        const addG = wallLanternLight * 20;

        // Walls keep v3's density of one texture per world unit HORIZONTALLY (texX above is
        // unchanged), but are now only WALL_HEIGHT tall - so squeezing the whole texture in
        // vertically compressed it by 0.62 and made bark and brick read as 1.6x too wide. Showing
        // only WALL_HEIGHT of the texture instead makes texels square again. Centring the crop
        // keeps wall-mounted detail (the lantern sconce sits around y=50-126) fully in frame.
        const step = (TEX_SIZE * WALL_HEIGHT) / lineHeight;
        const texTop = (TEX_SIZE * (1 - WALL_HEIGHT)) / 2;
        let texPos = texTop + (clampedStart - screenHeight / 2 + lineHeight / 2) * step;

        // One 32-bit store per pixel instead of four 8-bit ones - see PIX_ALPHA.
        let pIdx32 = clampedStart * screenWidth + x;
        for (let y = clampedStart; y <= clampedEnd; y++) {
          let texY = texPos | 0;
          if (texY < 0) texY = 0; else if (texY > TEX_SIZE - 1) texY = TEX_SIZE - 1;
          texPos += step;

          const tIdx = (texY * TEX_SIZE + texX) * 4;

          const r = wallData[tIdx] * finalShade + addR;
          const g = wallData[tIdx + 1] * finalShade + addG;
          const b = wallData[tIdx + 2] * finalShade;
          buf32[pIdx32] = PIX_ALPHA
            | ((r > 255 ? 255 : r) << PIX_R_SHIFT)
            | ((g > 255 ? 255 : g) << PIX_G_SHIFT)
            | ((b > 255 ? 255 : b) << PIX_B_SHIFT);
          pIdx32 += screenWidth;
        }
      }

      // Floor & Ceiling Casting
      //
      // Runs AFTER the walls and skips every pixel they already cover - see the note up there.
      for (let y = 0; y < screenHeight; y++) {
        const isFloor = y > screenHeight / 2;
        const p = isFloor ? (y - screenHeight / 2) : (screenHeight / 2 - y);
        if (p === 0) continue;

        // Eye level sits at half the wall height, so this has to track WALL_HEIGHT or the floor and
        // ceiling planes stop meeting the walls where they should.
        const posZ = (WALL_HEIGHT / 2) * screenHeight;
        const rowDist = posZ / p;

        const stepX = rowDist * (planeX * 2) / screenWidth;
        const stepY = rowDist * (planeY * 2) / screenWidth;

        let floorX = posX + rowDist * (dirX - planeX);
        let floorY = posY + rowDist * (dirY - planeY);

        const tex = isFloor ? floorTexture : ceilingTexture;
        const texData = tex.data;

        // Distance shading is constant along a row, so it comes out of the inner loop.
        const baseShade = Math.max(0.35, Math.min(1.0, 1.0 - (rowDist * 0.15)));

        let pIdx32 = y * screenWidth;
        for (let x = 0; x < screenWidth; x++, pIdx32++) {
          // A wall column already owns this pixel: step the texture coordinates on and move
          // along without sampling, lighting or writing anything.
          if (y >= wallTop[x] && y <= wallBot[x]) {
            floorX += stepX;
            floorY += stepY;
            continue;
          }

          // See SURFACE_TEXELS. One texture per map cell; the mask wraps at the cell boundary.
          const tx = Math.floor(floorX * SURFACE_TEXELS) & (TEX_SIZE - 1);
          const ty = Math.floor(floorY * SURFACE_TEXELS) & (TEX_SIZE - 1);

          // Baked lantern field, one bilinear tap - this is the read that used to walk every
          // lantern in the maze for every pixel on the screen.
          const lanternLight = sampleLight(floorLightMap, floorX, floorY);

          floorX += stepX;
          floorY += stepY;

          const tIdx = (ty * TEX_SIZE + tx) * 4;
          const finalShade = baseShade + lanternLight > 1.0 ? 1.0 : baseShade + lanternLight;

          const r = texData[tIdx] * finalShade + (lanternLight * 25);
          const g = texData[tIdx + 1] * finalShade + (lanternLight * 15);
          const b = texData[tIdx + 2] * finalShade;
          buf32[pIdx32] = PIX_ALPHA
            | ((r > 255 ? 255 : r) << PIX_R_SHIFT)
            | ((g > 255 ? 255 : g) << PIX_G_SHIFT)
            | ((b > 255 ? 255 : b) << PIX_B_SHIFT);
        }
      }

      // The exit stairwell, standing in the middle of the exit cell.
      //
      // FLOOR-anchored, not horizon-centred like the "End" placard this replaced. A hole in the
      // ground has to meet the ground: its bottom edge sits on the exit cell's floor line and it
      // rises from there, so the flight recedes UP the screen towards the vanishing point the
      // same way the corridor floor does. Centring it on the horizon (the placard's anchoring)
      // left it hanging in the air with corridor visible underneath.
      //
      // Width is one full map cell rather than a ratio of the height. A lateral world unit at
      // depth d covers screenWidth / (2*tan(halfFov)*d) pixels - the horizontal twin of the
      // screenHeight/d the wall pass uses vertically - so this makes the stone surround meet
      // the cell's own side walls at every distance instead of drifting with it.
      if (exitStairsTexture) {
        const spriteX = (exitRoom.x + 0.5) - posX;
        const spriteY = (exitRoom.y + 0.5) - posY;

        const invDet = 1.0 / (planeX * dirY - dirX * planeY);
        const transformX = invDet * (dirY * spriteX - dirX * spriteY);
        const transformY = invDet * (-planeY * spriteX + planeX * spriteY);

        if (transformY > 0.1) {
          const spriteScreenX = (screenWidth / 2) * (1 + transformX / transformY);
          const wallH = (screenHeight * WALL_HEIGHT) / transformY;
          const spriteWidth = (screenWidth / (2 * Math.tan(halfFov))) / transformY;
          const spriteHeight = wallH * EXIT_STAIRS_WALL_FRAC;
          // Bottom edge on the floor line of the cell the stairwell stands in.
          const floorY = screenHeight / 2 + wallH / 2;
          const topY = floorY - spriteHeight;
          const leftX = spriteScreenX - spriteWidth / 2;

          const drawStartY = Math.max(0, Math.floor(topY));
          const drawEndY = Math.min(screenHeight - 1, Math.ceil(floorY));
          const drawStartX = Math.max(0, Math.floor(leftX));
          const drawEndX = Math.min(screenWidth - 1, Math.ceil(leftX + spriteWidth));

          const signData = exitStairsTexture.data;
          // A touch of the wall pass's distance falloff, so the stairwell belongs to the
          // corridor rather than glowing at full brightness the way the old placard did. Only
          // a touch: this thing is lit from BEYOND the opening, not by the dungeon, and it is
          // the one landmark the player is looking for down a long dark hall. Shading it like
          // masonry (the walls' 0.38 falloff, no floor) turned it into a black rectangle at
          // three tiles and lost the exit entirely.
          const exitShade = Math.max(0.78, 1.0 / (1.0 + transformY * 0.16));

          for (let stripe = drawStartX; stripe <= drawEndX; stripe++) {
            const texX = Math.floor(((stripe - leftX) * EXIT_SPR_W) / spriteWidth);
            if (texX < 0 || texX >= EXIT_SPR_W) continue;
            // Same per-column depth test the walls wrote, so a stairwell glimpsed past a corner
            // is cut off by the corner rather than drawn over it.
            if (transformY >= zBuffer[stripe]) continue;

            for (let y = drawStartY; y <= drawEndY; y++) {
              const texY = Math.floor(((y - topY) * EXIT_SPR_H) / spriteHeight);
              if (texY < 0 || texY >= EXIT_SPR_H) continue;

              const sIdx = (texY * EXIT_SPR_W + texX) * 4;
              const alpha = signData[sIdx + 3] / 255;
              if (alpha <= 0.05) continue;

              const pIdx = (y * screenWidth + stripe) * 4;
              buffer[pIdx] = Math.floor(buffer[pIdx] * (1 - alpha) + signData[sIdx] * exitShade * alpha);
              buffer[pIdx + 1] = Math.floor(buffer[pIdx + 1] * (1 - alpha) + signData[sIdx + 1] * exitShade * alpha);
              buffer[pIdx + 2] = Math.floor(buffer[pIdx + 2] * (1 - alpha) + signData[sIdx + 2] * exitShade * alpha);
            }
          }
        }
      }

      // Open gates (MAP tile 6): a fixed planar segment across the doorway, NOT a camera-
      // facing billboard - a billboard always shows its full face no matter the viewing
      // angle, which looked wrong (rotated 90deg from how a real doorway would read) when
      // glimpsed from a crossing passage instead of straight down the door's own corridor.
      // Each screen column intersects the ray it already cast against the door's world-space
      // segment directly - same per-column exactness as the DDA wall pass above, so this
      // foreshortens correctly (full width head-on, edge-on from the side) with no fisheye
      // distortion and no affine texture warp to approximate away.
      if (doorOpenTexture && doorList.length) {
        const gData = doorOpenTexture.data;
        const NEAR = 0.2;
        const invDetCam = 1.0 / (planeX * dirY - dirX * planeY);

        for (const d of doorList) {
          if (!d.opened) continue;
          // Segment endpoints from the axis computed in placeGatesAndSwitches: 'x' spans
          // east-west across the tile at its vertical midline, 'y' spans north-south at its
          // horizontal midline.
          const p1x = d.axis === 'x' ? d.x : d.x + 0.5;
          const p1y = d.axis === 'x' ? d.y + 0.5 : d.y;
          const ex = d.axis === 'x' ? 1 : 0;
          const ey = d.axis === 'x' ? 0 : 1;
          const Ax = p1x - posX, Ay = p1y - posY;

          // Which screen columns can this doorway possibly touch?
          //
          // Every open gate in the maze used to solve a ray/segment intersection for all 320
          // columns, whether it was in front of the player or three rooms behind them. A
          // straight world segment projects to a straight span of screen columns, so both
          // endpoints through the camera transform bound it exactly - and a gate that is off
          // screen or behind the player costs two multiplies instead of 320 solves.
          const Bx = Ax + ex, By = Ay + ey;
          const t1Y = invDetCam * (-planeY * Ax + planeX * Ay);
          const t2Y = invDetCam * (-planeY * Bx + planeX * By);
          let colFrom = 0, colTo = screenWidth - 1;
          if (t1Y <= NEAR && t2Y <= NEAR) continue;         // wholly behind the camera
          if (t1Y > NEAR && t2Y > NEAR) {
            // Both ends in front, so the span between their projections is the whole doorway.
            // A single end behind the camera throws the projection out to infinity, and that
            // case just keeps the full sweep - it only happens standing in the gateway itself.
            const t1X = invDetCam * (dirY * Ax - dirX * Ay);
            const t2X = invDetCam * (dirY * Bx - dirX * By);
            const sx1 = (screenWidth / 2) * (1 + t1X / t1Y);
            const sx2 = (screenWidth / 2) * (1 + t2X / t2Y);
            colFrom = Math.max(0, Math.floor(Math.min(sx1, sx2)));
            colTo = Math.min(screenWidth - 1, Math.ceil(Math.max(sx1, sx2)));
            if (colFrom > colTo) continue;                  // projects clean off the screen
          }

          for (let x = colFrom; x <= colTo; x++) {
            const cameraX = 2 * x / screenWidth - 1;
            const rdx = dirX + planeX * cameraX;
            const rdy = dirY + planeY * cameraX;

            // Ray (posX,posY)+t*(rdx,rdy) meets segment p1+s*(ex,ey): solve the 2x2 system.
            const det = ex * rdy - ey * rdx;
            if (Math.abs(det) < 1e-6) continue;             // ray runs parallel to the door
            const t = (-Ax * ey + ex * Ay) / det;
            if (t <= NEAR || t >= zBuffer[x]) continue;     // behind camera, or wall-occluded
            const s = (rdx * Ay - rdy * Ax) / det;
            if (s < 0 || s > 1) continue;                   // ray misses the doorway's extent

            const texX = Math.min(DOOR_SPR_W - 1, Math.max(0, Math.floor(s * DOOR_SPR_W)));
            const spriteH = (screenHeight * WALL_HEIGHT) / t;   // same formula as a wall column
            const topY = screenHeight / 2 - spriteH / 2;
            const startY = Math.max(0, Math.floor(topY));
            const endY = Math.min(screenHeight - 1, Math.ceil(topY + spriteH));
            const shade = 1.0 / (1.0 + t * 0.38);
            const texScale = DOOR_SPR_H / spriteH;

            for (let y = startY; y <= endY; y++) {
              const texY = Math.floor((y - topY) * texScale);
              if (texY < 0 || texY >= DOOR_SPR_H) continue;
              const sIdx = (texY * DOOR_SPR_W + texX) * 4;
              const alpha = gData[sIdx + 3] / 255;
              if (alpha <= 0.05) continue;
              const pIdx = (y * screenWidth + x) * 4;
              const inv = 1 - alpha;
              buffer[pIdx]     = Math.min(255, buffer[pIdx]     * inv + gData[sIdx]     * shade * alpha);
              buffer[pIdx + 1] = Math.min(255, buffer[pIdx + 1] * inv + gData[sIdx + 1] * shade * alpha);
              buffer[pIdx + 2] = Math.min(255, buffer[pIdx + 2] * inv + gData[sIdx + 2] * shade * alpha);
            }
          }
        }
      }

      ctx.putImageData(imgData, 0, 0);

      // Roaming foes, drawn only out of battle - once a fight starts the duel owns the frame
      // and the marker the player is standing on would just be underfoot.
      if (!combatState.inBattle) {
        drawWorldEnemies(ctx, posX, posY, dirX, dirY, planeX, planeY);
      }

      // Render 3D Combat Entities
      drawCombatEnemy(ctx, screenWidth, screenHeight);
      // The hero draws straight into the scene, except part-way through a plain win's dither-out:
      // then they go through the scratch layer so the Bayer pattern punches holes in the finished
      // figure, exactly as a dissolving corpse is handled in drawCombatEnemy.
      const heroVis = playerWinVisibility();
      if (heroVis >= 1) {
        drawOverTheShoulderPlayer(ctx, screenWidth, screenHeight);
      } else if (heroVis > 0) {
        drawOverTheShoulderPlayer(fxLayer(), screenWidth, screenHeight);
        blitFxLayer(ctx, heroVis, 1);
      }
      drawCombatEffects(ctx);
    }

    // render3D used to end with drawInteractHint(ctx): a small "E : USE" / "LOCKED" / "THROWN"
    // label at the bottom of the screen whenever the player faced a door or switch tile.
    // Removed - it told the player a wall segment was interactive, and for a switch whether
    // it was already thrown, before they'd actually spotted the fixture themselves, which
    // undercut the same puzzle the switch-placement distance and the minimap change further
    // up exist to protect. Interacting is still fully discoverable from the door and switch
    // textures alone; it's just not spelled out in text anymore. interact() below dropped its
    // floating "IT'S LOCKED" / "ALREADY THROWN" / "THE GATE GRINDS OPEN" text for the same
    // reason, keeping only the sound cues and the fixtures' own visual state change.

    // ==========================================
    // MINIMAP & NAVIGATION (FOG OF WAR)
    // ==========================================
    const minimapCanvas = document.getElementById('minimapCanvas');
    const minimapCtx = minimapCanvas ? minimapCanvas.getContext('2d') : null;

    function drawMinimap() {
      if (!minimapCtx || passagesList.length === 0) return;
      const c = minimapCtx;
      c.fillStyle = '#000000';
      c.fillRect(0, 0, minimapCanvas.width, minimapCanvas.height);

      visitedTiles.add(`${player.gridX},${player.gridY}`);
      if (mapProgressBadge) {
        mapProgressBadge.textContent = `${visitedTiles.size}/${passagesList.length} Tiles`;
      }

      const tileSize = passagesList.length > 50 ? 14 : (passagesList.length > 25 ? 18 : 22);
      const centerX = minimapCanvas.width / 2;
      const centerY = minimapCanvas.height / 2;

      const offsetX = centerX - player.posX * tileSize;
      const offsetY = centerY - player.posY * tileSize;

      visitedTiles.forEach(vKey => {
        const [vx, vy] = vKey.split(',').map(Number);
        const rx = offsetX + vx * tileSize;
        const ry = offsetY + vy * tileSize;

        const isCurrent = (vx === player.gridX && vy === player.gridY);
        const isExit = (vx === exitRoom.x && vy === exitRoom.y);

        c.fillStyle = isCurrent ? '#16a34a' : (isExit ? '#eab308' : '#2563eb');
        c.fillRect(rx, ry, tileSize, tileSize);

        if (isExit) {
          c.fillStyle = '#000000';
          c.font = `bold ${Math.max(8, tileSize - 6)}px sans-serif`;
          c.textAlign = 'center';
          c.textBaseline = 'middle';
          c.fillText('★', rx + tileSize / 2, ry + tileSize / 2);
        }

        const adj = [
          { x: vx, y: vy - 1 },
          { x: vx, y: vy + 1 },
          { x: vx - 1, y: vy },
          { x: vx + 1, y: vy }
        ];

        adj.forEach(w => {
          if (w.x < 0 || w.x >= MAP_WIDTH || w.y < 0 || w.y >= MAP_HEIGHT) return;
          const mv = MAP[w.y][w.x];
          if (mv < 1) return;
          const wx = offsetX + w.x * tileSize;
          const wy = offsetY + w.y * tileSize;

          // An opened gate is a passage now, not a wall - floor-coloured with the jamb left
          // as an outline, so the map shows where the gate was and that it is through.
          if (mv === 6) {
            c.fillStyle = '#2563eb';
            c.fillRect(wx, wy, tileSize, tileSize);
            c.strokeStyle = '#b45309';
            c.lineWidth = 2;
            c.strokeRect(wx + 1, wy + 1, tileSize - 2, tileSize - 2);
            return;
          }

          c.fillStyle = '#334155';
          c.fillRect(wx, wy, tileSize, tileSize);
          c.strokeStyle = '#475569';
          c.lineWidth = 0.5;
          c.strokeRect(wx, wy, tileSize, tileSize);

          if (mv === 3) {
            c.fillStyle = '#b45309';
            c.fillRect(wx + 2, wy + 2, tileSize - 4, tileSize - 4);
          }
          // Switch tiles (4/5) get no marker - they render as a plain wall, same as any other.
          // The minimap would otherwise hand the player the solution to a puzzle whose whole
          // point is that the lever is placed away from its gate and has to be found in 3D.
        });
      });

      // Player Arrow
      c.save();
      c.translate(centerX, centerY);
      c.rotate(player.angle + Math.PI / 2);
      c.fillStyle = '#ef4444';
      c.beginPath();
      c.moveTo(0, -tileSize * 0.45);
      c.lineTo(tileSize * 0.35, tileSize * 0.35);
      c.lineTo(0, tileSize * 0.15);
      c.lineTo(-tileSize * 0.35, tileSize * 0.35);
      c.closePath();
      c.fill();
      c.strokeStyle = '#ffffff';
      c.lineWidth = 1;
      c.stroke();
      c.restore();

      // Check Victory Condition. Not while the ending cutscene has the viewport: a clip watched
      // from the victory box after the stairs ending leaves the player standing on the exit with
      // the box taken down for the replay, and it must not pop straight back up over the clip.
      const isExit = (player.gridX === exitRoom.x && player.gridY === exitRoom.y);
      if (isExit && victoryModal.classList.contains('hidden') && totalMoves > 0 && endingPhase === 'idle') {
        showVictoryBox(false);
      }
    }

    function updateHUD() {
      if (statusPos) {
        statusPos.textContent = `Spot (${player.gridX}, ${player.gridY}) [Facing ${DIRS[player.dirIndex]}]`;
      }
    }

    function easeInOutCubic(t) {
      return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    }

    function animate3D(targetX, targetY, targetAngle) {
      player.isAnimating = true;
      const startX = player.posX;
      const startY = player.posY;
      const startAngle = player.angle;
      const animStart = performance.now();
      // The step (and the turn - both come through here) takes 160ms at base. SPEED picks shorten
      // it, which is what "faster in exploration" means on a grid: the same tile, sooner. Divided
      // rather than multiplied - this is a duration, not a rate.
      const DURATION = 160 / playerSpeedMult();

      function step(now) {
        const elapsed = now - animStart;
        const progress = Math.min(1.0, elapsed / DURATION);
        const ease = easeInOutCubic(progress);

        player.posX = startX + (targetX - startX) * ease;
        player.posY = startY + (targetY - startY) * ease;
        player.angle = startAngle + (targetAngle - startAngle) * ease;

        // The tween owns the viewport while it runs (combatFrame stands down for it), so it
        // spends the shared frame budget here. The last frame always draws whatever the cap
        // says, so the step lands exactly on the target tile instead of a hair short of it.
        if (progress >= 1.0 || viewportFrameAllowed(now)) {
          render3D();
          drawMinimap();
        }

        if (progress < 1.0) {
          requestAnimationFrame(step);
        } else {
          player.posX = targetX;
          player.posY = targetY;
          player.angle = targetAngle;
          player.isAnimating = false;
          updateHUD();

          // Ambush check on arrival, not on the key press, so the step is seen through before
          // the room drops away and the duel slides in. startEncounter clears queuedAction, so
          // a key held down through the transition can't walk the player during the fight.
          checkEncounterAtPlayer();
          if (combatState.inBattle) return;

          if (queuedAction) {
            const next = queuedAction;
            queuedAction = null;
            if (next === 'UP') moveForward();
            else if (next === 'DOWN') moveBackward();
            else if (next === 'LEFT') rotateLeft();
            else if (next === 'RIGHT') rotateRight();
          }
        }
      }
      requestAnimationFrame(step);
    }

    function animateBump(dx, dy) {
      player.isAnimating = true;
      const startX = player.posX;
      const startY = player.posY;
      const bumpX = startX + dx * 0.18;
      const bumpY = startY + dy * 0.18;
      const animStart = performance.now();
      const OUT_DURATION = 90;
      const BACK_DURATION = 140;
      const TOTAL = OUT_DURATION + BACK_DURATION;

      function step(now) {
        const elapsed = now - animStart;

        if (elapsed < OUT_DURATION) {
          const ease = easeInOutCubic(Math.min(1, elapsed / OUT_DURATION));
          player.posX = startX + (bumpX - startX) * ease;
          player.posY = startY + (bumpY - startY) * ease;
        } else if (elapsed < TOTAL) {
          const ease = easeInOutCubic(Math.min(1, (elapsed - OUT_DURATION) / BACK_DURATION));
          player.posX = bumpX + (startX - bumpX) * ease;
          player.posY = bumpY + (startY - bumpY) * ease;
        } else {
          player.posX = startX;
          player.posY = startY;
        }

        if (elapsed >= TOTAL || viewportFrameAllowed(now)) {
          render3D();
          drawMinimap();
        }

        if (elapsed < TOTAL) {
          requestAnimationFrame(step);
        } else {
          player.isAnimating = false;

          if (queuedAction) {
            const next = queuedAction;
            queuedAction = null;
            if (next === 'UP') moveForward();
            else if (next === 'DOWN') moveBackward();
            else if (next === 'LEFT') rotateLeft();
            else if (next === 'RIGHT') rotateRight();
          }
        }
      }
      requestAnimationFrame(step);
    }

    // Face a tile and press Space: throw a wall switch (MAP 4 -> 5) to permanently open its door
    // (MAP 3 -> 0), or bump a still-locked door. Latching: a thrown switch stays on.
    function interact() {
      if (player.isAnimating || combatState.inBattle || inputLocked()) return;
      const vec = DIR_VECS[player.dirIndex];
      const fx = player.gridX + vec.dx;
      const fy = player.gridY + vec.dy;
      const t = (MAP[fy] && MAP[fy][fx] !== undefined) ? MAP[fy][fx] : 1;

      if (t === 4 || t === 5) {
        const sw = switchList.find(s => s.x === fx && s.y === fy);
        if (!sw) return;
        // The lever is only drawn on the face looking into its host cell (_switchFaceHit), so
        // it can only be thrown from there. Facing the same tile from another corridor shows
        // blank wall, and throwing an invisible switch through it would read as a bug.
        if (player.gridX !== sw.cellX || player.gridY !== sw.cellY) return;
        if (sw.on) return;                  // already thrown - the inverted fixture says so
        sw.on = true;
        MAP[fy][fx] = 5;
        playSfx('button', { vary: 0.06 });
        const door = doorList.find(d => d.index === sw.doorIndex);
        if (door && !door.opened) {
          door.opened = true;
          MAP[door.y][door.x] = 6;          // opened gate: walkable, still drawn as a doorway
          passagesList.push({ x: door.x, y: door.y });
          playSfx('end', { vary: 0.04, gain: 0.6 });
        }
        return;
      }

      if (t === 3) {
        playSfx('bump');                    // still shut - the door's own texture shows that
      }
    }

    // Walkable floor: open corridor (0) or an opened gate (6). Everything else - wall (1),
    // lantern (2), still-locked door (3), switch plate (4/5) - is solid.
    function isWalkable(x, y) {
      const row = MAP[y];
      if (!row) return false;
      const t = row[x];
      return t === 0 || t === 6;
    }

    function moveForward() {
      if (inputLocked() || combatState.inBattle) return;
      if (player.isAnimating) { queuedAction = 'UP'; return; }
      const vec = DIR_VECS[player.dirIndex];
      const nextX = player.gridX + vec.dx;
      const nextY = player.gridY + vec.dy;

      if (isWalkable(nextX, nextY)) {
        player.gridX = nextX;
        player.gridY = nextY;
        totalMoves++;
        playSfx('step');
        animate3D(nextX + 0.5, nextY + 0.5, player.angle);
      } else {
        playSfx('bump');
        animateBump(vec.dx, vec.dy);
      }
    }

    function moveBackward() {
      if (inputLocked() || combatState.inBattle) return;
      if (player.isAnimating) { queuedAction = 'DOWN'; return; }
      const vec = DIR_VECS[player.dirIndex];
      const nextX = player.gridX - vec.dx;
      const nextY = player.gridY - vec.dy;

      if (isWalkable(nextX, nextY)) {
        player.gridX = nextX;
        player.gridY = nextY;
        totalMoves++;
        playSfx('step', { rate: 0.94 });
        animate3D(nextX + 0.5, nextY + 0.5, player.angle);
      } else {
        playSfx('bump');
        animateBump(-vec.dx, -vec.dy);
      }
    }

    function rotateLeft() {
      if (inputLocked() || combatState.inBattle) return;
      if (player.isAnimating) { queuedAction = 'LEFT'; return; }
      player.dirIndex = (player.dirIndex + 3) % 4;
      playSfx('turn');
      animate3D(player.posX, player.posY, player.angle - Math.PI / 2);
    }

    function rotateRight() {
      if (inputLocked() || combatState.inBattle) return;
      if (player.isAnimating) { queuedAction = 'RIGHT'; return; }
      player.dirIndex = (player.dirIndex + 1) % 4;
      playSfx('turn');
      animate3D(player.posX, player.posY, player.angle + Math.PI / 2);
    }

    // ==========================================
    // EVENT LISTENERS & INITIALIZATION
    // ==========================================
    btnUp.addEventListener('pointerdown', (e) => { e.preventDefault(); moveForward(); });
    btnDown.addEventListener('pointerdown', (e) => { e.preventDefault(); moveBackward(); });
    btnLeft.addEventListener('pointerdown', (e) => { e.preventDefault(); rotateLeft(); });
    btnRight.addEventListener('pointerdown', (e) => { e.preventDefault(); rotateRight(); });
    if (btnAction) btnAction.addEventListener('pointerdown', (e) => { e.preventDefault(); interact(); });

    window.addEventListener('keydown', (e) => {
      if (screenGame.classList.contains('hidden')) return;

      // The quit-confirm box is up: ESC again backs out of it exactly like clicking its own
      // ✕ or the darkened game behind it, and nothing else here reaches the dungeon. While
      // the erase box is stacked on top, ESC peels off that one first and the quit box stays.
      if (modalQuitConfirm && !modalQuitConfirm.classList.contains('hidden')) {
        if (e.code === 'Escape') {
          e.preventDefault();
          if (modalEraseConfirm && !modalEraseConfirm.classList.contains('hidden')) {
            cancelEraseConfirm();
          } else {
            closeQuitConfirm();
          }
        }
        return;
      }

      // "Load a Different Dungeon" opens History over the still-running game rather than
      // exiting to the menu first, so the same has to hold here: movement/combat keys stop
      // dead, and ESC is left to the dedicated History/Settings ESC listener further down
      // the file, which already closes these regardless of which screen is showing.
      if ((modalHistory && !modalHistory.classList.contains('hidden')) ||
          (modalHistoryConfirm && !modalHistoryConfirm.classList.contains('hidden')) ||
          (modalLeaveRunConfirm && !modalLeaveRunConfirm.classList.contains('hidden'))) {
        return;
      }

      // The ending cutscene owns the keyboard from the killing blow until its victory box is up.
      // ESC or Enter skips to the clip's last frame, and pressed again during the hold on that
      // frame raises the box at once; every other key is swallowed, so a strike still being
      // mashed through the blow does nothing behind the clip. Space and the arrows are held off
      // their browser defaults too - the focused combat button would take a Space.
      if (endingPhase === 'pending' || endingPhase === 'playing' || endingHolding()) {
        if (e.code === 'Escape' || e.code === 'Enter' || e.code === 'NumpadEnter') {
          e.preventDefault();
          e.stopImmediatePropagation();
          if (endingPhase === 'playing') skipEndingCutscene();
          else if (endingHolding()) raiseEndingVictoryBox();
        } else if (e.code === 'Space' || e.code.startsWith('Arrow')) {
          e.preventDefault();
        }
        return;
      }

      // The victory box is up: ↑↓ (also ←→ / WASD) move the cursor between its buttons -
      // "Watch / Replay Ending" when there is a cutscene, "Favorite this run" and "Back to Main
      // Menu" - and Enter/Space takes the highlighted one, same pattern as the death box below.
      // Defaults to Main Menu (see showVictoryBox) so a bare Enter still exits instantly, same as
      // before this had more than one button to choose between.
      if (victoryModal && !victoryModal.classList.contains('hidden')) {
        if (['ArrowUp', 'KeyW', 'ArrowLeft', 'KeyA'].includes(e.code)) {
          e.preventDefault();
          moveVictorySelection(-1);
        } else if (['ArrowDown', 'KeyS', 'ArrowRight', 'KeyD'].includes(e.code)) {
          e.preventDefault();
          moveVictorySelection(1);
        } else if (e.code === 'Enter' || e.code === 'NumpadEnter' || e.code === 'Space') {
          e.preventDefault();
          // Stop the same keypress reaching the setup-screen listener below, which would
          // otherwise see the now-visible setup screen and fire CREATE.
          e.stopImmediatePropagation();
          takeVictoryChoice();
        }
        return;
      }

      // The death box is up: ↑↓ (also ←→ / WASD) move the cursor between its two buttons -
      // "Restart Dungeon" and "Back to Main Menu" - and Enter/Space takes the highlighted
      // one, so a lost run never needs the mouse or a reach for Tab to leave or retry.
      if (defeatModal && !defeatModal.classList.contains('hidden')) {
        if (['ArrowUp', 'KeyW', 'ArrowLeft', 'KeyA'].includes(e.code)) {
          e.preventDefault();
          moveDeadSelection(-1);
        } else if (['ArrowDown', 'KeyS', 'ArrowRight', 'KeyD'].includes(e.code)) {
          e.preventDefault();
          moveDeadSelection(1);
        } else if (e.code === 'Enter' || e.code === 'NumpadEnter' || e.code === 'Space') {
          e.preventDefault();
          // Same guard as the victory box: "Back to Main Menu" un-hides the setup screen, and
          // the setup-screen listener below must not see it and fire CREATE on this keypress.
          e.stopImmediatePropagation();
          takeDeadChoice();
        }
        return;
      }

      // The level-up box owns the keyboard while it is up: 1/2/3/4 take a path outright, the
      // arrows move the cursor and Space/Enter confirms it. Nothing falls through to the
      // dungeon, and there is no key that dismisses the box without choosing.
      if (levelUpOpen) {
        e.preventDefault();
        if (e.code === 'Digit1' || e.code === 'Numpad1') applyLevelChoice('strength');
        else if (e.code === 'Digit2' || e.code === 'Numpad2') applyLevelChoice('stamina');
        else if (e.code === 'Digit3' || e.code === 'Numpad3') applyLevelChoice('survival');
        else if (e.code === 'Digit4' || e.code === 'Numpad4') applyLevelChoice('speed');
        else if (['ArrowUp', 'KeyW', 'ArrowLeft', 'KeyA'].includes(e.code)) moveLevelUpSelection(-1);
        else if (['ArrowDown', 'KeyS', 'ArrowRight', 'KeyD'].includes(e.code)) moveLevelUpSelection(1);
        else if (e.code === 'Space' || e.code === 'Enter') {
          applyLevelChoice(LEVEL_CHOICE_KEYS[progression.choiceIndex]);
        }
        return;
      }

      if (combatState.inBattle) {
        // Space had been the flee key. There is no fleeing now - the fight ends when one of the
        // two goes down - but it still has to be swallowed, or it re-triggers whichever combat
        // button the pointer last left focused.
        if (e.code === 'Space') { e.preventDefault(); return; }
        if (combatState.dead) return;   // no dodging, guarding or swinging from beyond the grave
        if (['KeyA', 'ArrowLeft'].includes(e.code)) {
          e.preventDefault();
          keysHeld.left = true;
        } else if (['KeyD', 'ArrowRight'].includes(e.code)) {
          e.preventDefault();
          keysHeld.right = true;
        } else if (['KeyX', 'KeyS', 'ArrowDown', 'KeyK'].includes(e.code)) {
          e.preventDefault();
          keysHeld.block = true;
        } else if (['KeyZ', 'KeyW', 'ArrowUp', 'KeyJ'].includes(e.code)) {
          e.preventDefault();
          combatAttack();
        }
        return;
      }

      // ESC in free exploration does exactly what the title-bar ✕ does here: opens the
      // quit-confirm box. The guard at the top of this handler catches ESC again once it's
      // up; in battle the block above has already returned, and every open box (victory /
      // defeat / level-up) returned earlier still, so this only reaches while walking.
      if (e.code === 'Escape') {
        e.preventDefault();
        btnClose.click();
        return;
      }

      if (['ArrowUp', 'KeyW'].includes(e.code)) {
        e.preventDefault();
        moveForward();
      } else if (['ArrowDown', 'KeyS'].includes(e.code)) {
        e.preventDefault();
        moveBackward();
      } else if (['ArrowLeft', 'KeyA'].includes(e.code)) {
        e.preventDefault();
        rotateLeft();
      } else if (['ArrowRight', 'KeyD'].includes(e.code)) {
        e.preventDefault();
        rotateRight();
      } else if (e.code === 'Space' || e.code === 'Enter' || e.code === 'KeyE') {
        // Space is the Use key now. It used to toggle battle mode, which only ever existed so
        // fights could be tested; battles start by walking onto a foe in the corridor instead.
        // E does the same thing - undocumented, but it's the key hand people reach for.
        e.preventDefault();
        interact();
      }
    });

    window.addEventListener('keyup', (e) => {
      if (['KeyA', 'ArrowLeft'].includes(e.code)) {
        keysHeld.left = false;
      } else if (['KeyD', 'ArrowRight'].includes(e.code)) {
        keysHeld.right = false;
      } else if (['KeyX', 'KeyS', 'ArrowDown', 'KeyK'].includes(e.code)) {
        keysHeld.block = false;
      }
    });

    // One attach/clear implementation shared by the player, weapon and enemy madlib lines, rather
    // than three near-identical copies. `key` indexes into attachedImages.
    function wireImageAttach(key, ids) {
      const promptInput = document.getElementById(ids.prompt);
      const fileInput = document.getElementById(ids.file);
      const attachBtn = document.getElementById(ids.attach);
      const badge = document.getElementById(ids.badge);
      const thumb = document.getElementById(ids.thumb);
      const nameEl = document.getElementById(ids.name);
      const clearBtn = document.getElementById(ids.clear);
      if (!promptInput || !fileInput || !attachBtn) return;

      attachBtn.addEventListener('click', () => fileInput.click());

      fileInput.addEventListener('change', (e) => {
        const file = e.target.files && e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = (event) => {
          const img = new Image();
          img.onload = () => {
            const maxDim = 512;
            let w = img.width, h = img.height;
            if (w > maxDim || h > maxDim) {
              if (w > h) { h = Math.round((h * maxDim) / w); w = maxDim; }
              else { w = Math.round((w * maxDim) / h); h = maxDim; }
            }
            const cv = document.createElement('canvas');
            cv.width = w; cv.height = h;
            cv.getContext('2d').drawImage(img, 0, 0, w, h);
            const dataUrl = cv.toDataURL('image/jpeg', 0.88);

            attachedImages[key] = dataUrl;
            if (key === 'player') uploadedPlayerImageDataUrl = dataUrl;
            if (thumb) thumb.src = dataUrl;
            if (nameEl) nameEl.textContent = file.name;
            if (badge) badge.classList.remove('hidden');
            promptInput.disabled = true;
            promptInput.value = "";
            // Attaching throws away whatever was typed on this line, so it is an undo step -
            // and one step, not "field blanked" plus "image added". Recorded here inside the
            // decode callback rather than at the click, because until now there was nothing
            // to record: the file is still being read at that point.
            recordSetupChange(null);
          };
          img.src = event.target.result;
        };
        reader.readAsDataURL(file);
      });

      if (clearBtn) {
        clearBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          fileInput.value = "";
          attachedImages[key] = null;
          if (key === 'player') uploadedPlayerImageDataUrl = null;
          if (thumb) thumb.src = "";
          if (nameEl) nameEl.textContent = "";
          if (badge) badge.classList.add('hidden');
          promptInput.disabled = false;
          promptInput.focus();
          recordSetupChange(null);
        });
      }
    }

    wireImageAttach('player', {
      prompt: 'playerPromptInput', file: 'playerFileInput', attach: 'btnAttachPlayerImage',
      badge: 'playerImageBadge', thumb: 'playerImageThumb', name: 'playerImageName',
      clear: 'btnClearPlayerImage'
    });
    wireImageAttach('weapon', {
      prompt: 'weaponPromptInput', file: 'weaponFileInput', attach: 'btnAttachWeaponImage',
      badge: 'weaponImageBadge', thumb: 'weaponImageThumb', name: 'weaponImageName',
      clear: 'btnClearWeaponImage'
    });
    wireImageAttach('enemy', {
      prompt: 'enemyPromptInput', file: 'enemyFileInput', attach: 'btnAttachEnemyImage',
      badge: 'enemyImageBadge', thumb: 'enemyImageThumb', name: 'enemyImageName',
      clear: 'btnClearEnemyImage'
    });

    function imageToTexture(img, flipX = false) {
      const cv = document.createElement('canvas');
      cv.width = cv.height = TEX_SIZE;
      const c = cv.getContext('2d');
      c.imageSmoothingEnabled = false;
      // flipX mirrors the source before it becomes a texture. The wall raycaster flips texX on
      // two of the four faces so tiling art stays consistent, and the net effect on AI wall art
      // (which usually carries baked-in text) was that the text read backwards on approach.
      // Pre-mirroring the wall slab cancels that out - same trick buildDoorTexture uses.
      if (flipX) { c.translate(TEX_SIZE, 0); c.scale(-1, 1); }
      c.drawImage(img, 0, 0, TEX_SIZE, TEX_SIZE);
      return c.getImageData(0, 0, TEX_SIZE, TEX_SIZE);
    }

    // onReady (optional) fires once every requested texture has actually decoded, instead of
    // the caller assuming that's already true. enterDungeon relies on this to hold the game
    // screen back until the real art is in wallTexture/ceilingTexture/floorTexture - otherwise
    // the first render3D() paints whatever was already loaded (the Windows-95 defaults, or the
    // previous dungeon's art) and the swap to the new textures a moment later reads as a flash.
    function loadAiTextures(wallUri, ceilUri, floorUri, styleName = "Windows 95", lanternUri, onReady, doorUri, switchUri) {
      // Cleared unconditionally: a dungeon with no lantern art (e.g. the Windows 95 style,
      // which keeps its procedural logo gag - see get_surface_prompts) must not keep showing
      // the PREVIOUS dungeon's AI fixture. Same for the door/switch cutouts.
      aiLanternImg = null;
      aiDoorImg = null;
      aiSwitchImg = null;
      const total = [wallUri, ceilUri, floorUri, lanternUri, doorUri, switchUri].filter(Boolean).length;
      let loaded = 0;

      function finish() {
        if (activeMode !== 'v1_video') {
          buildLanternWallFromBase(wallTexture, styleName);
          buildExitStairsTexture(styleName, wallTexture);
          buildDoorTexture(wallTexture, styleName);
          buildOpenDoorTexture();
          buildSwitchWallTextures(wallTexture, styleName);
        }
        if (onReady) {
          onReady();
        } else {
          render3D();
          drawMinimap();
        }
      }

      function checkDone() {
        loaded++;
        if (loaded >= total) finish();
      }

      if (wallUri) {
        const imgW = new Image();
        imgW.onload = () => { wallTexture = imageToTexture(imgW, true); checkDone(); };
        imgW.src = wallUri;
      }
      if (ceilUri) {
        const imgC = new Image();
        imgC.onload = () => { ceilingTexture = imageToTexture(imgC); checkDone(); };
        imgC.src = ceilUri;
      }
      if (floorUri) {
        const imgF = new Image();
        imgF.onload = () => { floorTexture = imageToTexture(imgF); checkDone(); };
        imgF.src = floorUri;
      }
      if (lanternUri) {
        const imgL = new Image();
        // Kept as an Image (not converted via imageToTexture) - buildLanternWallFromBase
        // drawImage()s it directly so its alpha channel survives the composite.
        imgL.onload = () => { aiLanternImg = imgL; checkDone(); };
        imgL.src = lanternUri;
      }
      if (doorUri) {
        const imgD = new Image();
        imgD.onload = () => { aiDoorImg = imgD; checkDone(); };
        imgD.src = doorUri;
      }
      if (switchUri) {
        const imgS = new Image();
        imgS.onload = () => { aiSwitchImg = imgS; checkDone(); };
        imgS.src = switchUri;
      }

      if (total === 0) finish();
    }

    // Load a finished bundle into the engine and show the game. Split out of the poll
    // loop so the transition is driven by the ENTER button instead of firing the moment
    // generation happens to finish.
    function enterDungeon(b) {
      if (!b) return;
      // Playing now, so the tab stops advertising a run that already started.
      resetTabTitle();
      // New run, new pack colours. Rolled here rather than in restartDungeon, which rolls THIS
      // run back to its first step and so keeps the foes the player has already met looking the
      // way they looked. Has to land before the first render either way: the world markers tint
      // through the same enemyFramesFor path the battle sprites do.
      rollPackHues();
      // Freeze the dungeon's start-of-run state now, while nothing has moved and every gate is
      // still shut, so the death screen's "Restart Dungeon" can roll back to exactly here.
      dungeonSnapshot = {
        bundle: b,
        map: MAP.map(row => row.slice()),
        passages: passagesList.map(p => ({ x: p.x, y: p.y })),
        doors: doorList.map(d => ({ ...d })),
        switches: switchList.map(s => ({ ...s })),
        enemies: enemyMarkers.map(m => ({ ...m })),
        player: { ...player }
      };
      // A brand new dungeon is a brand new hero: level 1, base bars, no banked picks.
      resetProgression();
      updateProgressionHUD();
      // Does this run have an ending cutscene, or one filming? currentRunHistoryId is already
      // this run's by now - set by the poll loop for a fresh run, by loadHistoryDungeon for a
      // replay. Asked at ENTER rather than at arming, so a player who sits on the crawl still
      // gets a clip that finished while they read.
      prepareEndingCutscene();
      // Narration keeps playing across screen changes; silence it before the game starts.
      stopNarration();
      // ...and drop the crawl-reading hold with it. startCrawl() sets crawlReadingUntil up to
      // a few minutes out; without this it keeps screensaverBlocked() true long after the
      // player has left the loading screen, so the idle saver - and the ✕ that forces it -
      // do nothing back on the menu until that stale timer finally elapses.
      crawlReadingUntil = 0;
      // The loading loop plays right up to this click - fade it out under the start sting.
      stopScreenMusic();
      // Fetch the win and death loops now, while the player still has a whole dungeon between
      // them and either box. Decoding a 90s buffer at the moment of death would be audible.
      loadScreenMusic('death');
      // Which win loop this run gets - decided here, off the style the run was actually built
      // from (b.wall_style survives a History replay; currentThemeName covers a bundle saved
      // before that field existed). Only the chosen one is fetched: the pool is six 5MB
      // buffers, and pulling all six down to play one would cost the player 28MB for nothing.
      loadScreenMusic(pickRunVictoryTrack(b.wall_style || currentThemeName));
      // The level-up loop is wanted mid-run and with no warning - the box opens the instant a
      // kill crosses a threshold - so it has to be in memory before the first fight, not
      // fetched when it is already needed.
      loadScreenMusic('levelup');
      // Belt-and-braces: playScreenMusic already retired the menu loop when the narrator
      // finished, but nothing should still be playing it once the dungeon itself starts.
      menuMusicStopped = true;
      stopMenuMusicLoop();
      // v6 ships bundle.sfx; every other mode leaves it undefined and playSfx falls back to
      // the procedural bank.
      loadSfxBank(b.sfx);
      playSfx('start', { vary: 0, gain: START_STING_GAIN });   // fixed pitch: a signature, not foley
      // v6 with sound_mode "music_and_sound" ships bundle.music; everything else leaves it
      // undefined and loadMusicBank just tears down the previous dungeon's loops.
      loadMusicBank(b.music);
      if (b.player_sprites && b.player_sprites.length > 0) {
        playerSpriteFrames = [];
        b.player_sprites.forEach(src => {
          const img = new Image();
          img.src = src;
          playerSpriteFrames.push(img);
        });
        playerSpriteImg = playerSpriteFrames[0];
      } else if (b.player_sprite) {
        playerSpriteImg = new Image();
        playerSpriteImg.src = b.player_sprite;
        playerSpriteFrames = [playerSpriteImg];
      }
      // v5 (krea2): separately generated weapon & shield sprites the rig animates
      // as overlays. Cleared first so switching back to another mode drops them.
      weaponSpriteImg = null;
      shieldSpriteImg = null;
      if (b.weapon_sprite) {
        weaponSpriteImg = new Image();
        weaponSpriteImg.src = b.weapon_sprite;
      }
      if (b.shield_sprite) {
        shieldSpriteImg = new Image();
        shieldSpriteImg.src = b.shield_sprite;
      }
      playerFaceFrames = [];
      if (b.player_faces && b.player_faces.length > 0) {
        b.player_faces.forEach(src => {
          const img = new Image();
          img.src = src;
          playerFaceFrames.push(img);
        });
        playerFaceImg = playerFaceFrames[0];
      } else if (b.player_face) {
        playerFaceImg = new Image();
        playerFaceImg.src = b.player_face;
        playerFaceFrames = [playerFaceImg];
      }
      enemySpriteFrames = [];
      enemyVariantImgs = {};
      enemyFrames = null;
      // walker / flyer / boss, each with its own {idle, attack, block?} sprites. A bundle
      // generated before the extra frames existed sends a bare data URL per variant, so
      // accept that shape too and treat it as an idle-only foe. Older modes send only
      // enemy_sprites - fold that in as the walker.
      if (b.enemy_variants) {
        Object.entries(b.enemy_variants).forEach(([key, val]) => {
          if (!val) return;
          const srcs = (typeof val === 'string') ? { idle: val } : val;
          const set = {};
          Object.entries(srcs).forEach(([frame, src]) => {
            if (!src) return;
            const img = new Image();
            img.src = src;
            set[frame] = img;
          });
          if (set.idle) enemyVariantImgs[key] = set;
        });
      }
      if (b.enemy_sprites && b.enemy_sprites.length > 0) {
        b.enemy_sprites.forEach(src => {
          const img = new Image();
          img.src = src;
          enemySpriteFrames.push(img);
        });
        if (!enemyVariantImgs.walker) enemyVariantImgs.walker = { idle: enemySpriteFrames[0] };
      }
      // Common foe name (walker/flyer) vs. the boss's own name (boss variant) - see
      // pickEnemyVariant, which is what actually assigns combatState.enemy.name.
      enemyStyleName = ((dungeonStory && dungeonStory.foe) || b.enemy_style || '').trim();
      enemyBossName = ((dungeonStory && dungeonStory.boss) || '').trim();
      enemyVariantNames = (b.enemy_names && typeof b.enemy_names === 'object') ? b.enemy_names : {};
      pickEnemyVariant();

      const showGameScreen = () => {
        screenProgress.classList.add('hidden');
        screenGame.classList.remove('hidden');
        if (titleButtons) titleButtons.classList.remove('hidden');
        appContainer.className = 'win95-box p-1 text-black mode-game';
        render3D();
        drawMinimap();
        updateHUD();
      };

      if (activeMode === 'v1_video') {
        // Video mode never raycasts these textures, so there's nothing worth blocking on.
        loadAiTextures(b.wall_texture, b.ceiling_texture, b.floor_texture, b.wall_style || currentThemeName, b.lantern_texture, null, b.door_texture, b.switch_texture);
        showGameScreen();
      } else {
        // Hold the game screen (and its first render3D()) until the real wall/ceiling/floor/
        // lantern art has decoded, so the player never sees a frame of stale textures before
        // the swap.
        loadAiTextures(b.wall_texture, b.ceiling_texture, b.floor_texture, b.wall_style || currentThemeName, b.lantern_texture, showGameScreen, b.door_texture, b.switch_texture);
      }
    }

    // ---- Intro crawl -------------------------------------------------------
    // Rendered as soon as the story lands, while every sprite is still being generated.
    // The CSS animation runs with fill-mode forwards, so if the text outruns the art it
    // simply settles on its last frame and holds while the bar keeps moving underneath.
    const CRAWL_SECONDS_PER_PARAGRAPH = 22;
    const CRAWL_MIN_SECONDS = 55;

    function startCrawl(story) {
      if (!story || crawlStarted) return;
      crawlStarted = true;
      dungeonStory = story;
      applyHeroStatusLabel();

      const paras = Array.isArray(story.crawl) ? story.crawl : [];
      const frag = document.createDocumentFragment();

      const title = document.createElement('p');
      title.className = 'crawl-title';
      title.textContent = (story.location || 'THE DUNGEON').toUpperCase();
      frag.appendChild(title);

      paras.forEach(text => {
        const p = document.createElement('p');
        p.textContent = text;   // textContent, not innerHTML: this string came from a model
        frag.appendChild(p);
      });

      // The closing send-off: one short line, visually set apart from the crawl proper.
      // Appended last so it lines up with the final clip in story.audio (server order is
      // title, each crawl paragraph, then the hook).
      if (story.hook) {
        const hook = document.createElement('p');
        hook.className = 'crawl-hook';
        hook.textContent = story.hook;
        frag.appendChild(hook);
      }

      crawlText.innerHTML = '';
      crawlText.appendChild(frag);
      if (crawlPending) crawlPending.style.display = 'none';

      const seconds = Math.max(CRAWL_MIN_SECONDS,
                               (paras.length + (story.hook ? 2 : 1)) * CRAWL_SECONDS_PER_PARAGRAPH);
      crawlText.style.setProperty('--crawl-duration', seconds + 's');
      crawlReadingUntil = Date.now() + seconds * 1000;
      // Restart cleanly if a previous dungeon left the animation on the node.
      crawlText.classList.remove('rolling');
      void crawlText.offsetWidth;
      crawlText.classList.add('rolling');

      startNarration();
      // A story with no audio (generation failed, or a mode that never renders any) has no
      // "when the narrator stops" moment to wait for, so the loading loop starts now.
      if (!narrationActive()) playScreenMusic('loading');
    }

    // Classic Win98 install-bar: fixed-pitch blocks sized to the trough's actual width, so
    // the row always reaches the right edge at 100% instead of a static chunk count leaving
    // a gap (or, before the trough had a real width, a bar that could never show any chunks
    // at all). Driven by the poll loop while generating, and slammed to 100% by the History
    // window, which has nothing to wait for.
    function paintProgressChunks(percent) {
      if (!progBarChunks) return;
      const chunkPitch = 12; // .win95-prog-chunk: 10px wide + 2px margin-right
      const troughWidth = progBarChunks.parentElement
        ? progBarChunks.parentElement.clientWidth
        : 0;
      const maxChunks = Math.max(1, Math.floor(troughWidth / chunkPitch));
      const chunkCount = Math.round((Math.max(0, Math.min(100, percent)) / 100) * maxChunks);
      progBarChunks.innerHTML = '';
      for (let i = 0; i < chunkCount; i++) {
        const ch = document.createElement('div');
        ch.className = 'win95-prog-chunk';
        progBarChunks.appendChild(ch);
      }
    }

    function resetCrawl(enterButtonLabel = 'GENERATING ASSETS') {
      // Before anything else: a second CREATE must not leave the previous dungeon's
      // narrator talking over the new one, or its loading loop running under the menu music
      // this screen opens on.
      stopNarration();
      stopScreenMusic();
      crawlStarted = false;
      crawlReadingUntil = 0;
      if (crawlStage) crawlStage.style.display = '';
      if (progHeaderText) progHeaderText.textContent = 'Generating Dungeon Assets & Character...';
      if (progHeaderIcon) progHeaderIcon.textContent = '\u23f3';
      if (progPhaseText) progPhaseText.textContent = '';
      pendingBundle = null;
      dungeonStory = null;
      applyHeroStatusLabel();
      if (crawlText) {
        crawlText.classList.remove('rolling');
        crawlText.innerHTML = '';
      }
      if (crawlPending) crawlPending.style.display = '';
      if (btnEnterDungeon) {
        btnEnterDungeon.disabled = true;
        btnEnterDungeon.textContent = enterButtonLabel;
      }
    }

    // Assets are ready, but the player decides when to stop reading.
    function armEnterDungeon(bundle) {
      playSfx('ready');
      pendingBundle = bundle;
      if (bundle && bundle.story) {
        dungeonStory = bundle.story;
        startCrawl(bundle.story);
      } else if (!crawlStarted) {
        // Legacy v1-v4 modes never generate a story; collapse the stage rather than leave
        // "The chronicle is being written..." sitting there after everything is done.
        if (crawlStage) crawlStage.style.display = 'none';
      }
      // Loading is done, so the loading loop scores whatever reading time the player takes
      // before pressing ENTER. Checked after startCrawl above rather than before it, because
      // on a bundle that carries its own story the narrator only arms on that line - if the
      // narrator is now running it gets to finish first and finishNarration() starts the
      // loop, so the two never overlap.
      if (!narrationActive()) playScreenMusic('loading');
      const where = (dungeonStory && dungeonStory.location) ? dungeonStory.location : '';
      btnEnterDungeon.textContent = where ? ('ENTER ' + where.toUpperCase()) : 'ENTER THE DUNGEON';
      btnEnterDungeon.disabled = false;
      btnEnterDungeon.classList.add('bg-yellow-100');

      // Nothing is generating any more, so the whole progress readout stops pretending.
      // That includes the ✕'s box if it happens to be open: the assets landed while it was
      // asking whether to stop them, so it rewords itself from "stop" to "leave" rather than
      // offering to call off a run that has already finished.
      if (modalLoadingExitConfirm && !modalLoadingExitConfirm.classList.contains('hidden')) {
        openLoadingExitConfirm();
      }
      setTabTitleReady();
      if (progHeaderText) progHeaderText.textContent = 'Generated!';
      if (progHeaderIcon) progHeaderIcon.textContent = '\u2705';
      progStatusText.textContent = 'Done.';
      if (progPhaseText) progPhaseText.textContent = '';
    }

    function tryEnterDungeon() {
      if (!pendingBundle) return;
      const b = pendingBundle;
      pendingBundle = null;
      enterDungeon(b);
    }

    if (btnEnterDungeon) {
      btnEnterDungeon.addEventListener('click', tryEnterDungeon);
    }

    // On the loading screen, once assets are ready (ENTER button armed), Space or Enter
    // starts the game just like clicking the button. Gated on the progress screen being
    // up and the button being enabled, so it can't fire mid-generation or from the game.
    window.addEventListener('keydown', (e) => {
      if (e.code !== 'Space' && e.code !== 'Enter') return;
      if (screenProgress.classList.contains('hidden')) return;
      // Both boxes that can be up over the crawl now - the title bar's ? and the ✕'s
      // confirm - own the keyboard while they are: a Space meant for "Keep Generating"
      // must not start the dungeon out from under them.
      if (modalAbout && !modalAbout.classList.contains('hidden')) return;
      if (modalLoadingExitConfirm && !modalLoadingExitConfirm.classList.contains('hidden')) return;
      if (!btnEnterDungeon || btnEnterDungeon.disabled || !pendingBundle) return;
      e.preventDefault();
      tryEnterDungeon();
    });

    // On the setup screen, Enter kicks off generation just like clicking CREATE. Ignored
    // while the Options modal is up, and while focus is in a textarea (so a multi-line
    // prompt field keeps its newline).
    window.addEventListener('keydown', (e) => {
      if (e.code !== 'Enter') return;
      if (screenSetup.classList.contains('hidden')) return;
      if (modalSettings && !modalSettings.classList.contains('hidden')) return;
      if (modalAbout && !modalAbout.classList.contains('hidden')) return;
      if (modalHistory && !modalHistory.classList.contains('hidden')) return;
      if (modalHistoryConfirm && !modalHistoryConfirm.classList.contains('hidden')) return;
      if (e.target && e.target.tagName === 'TEXTAREA') return;
      // Now that the arrow keys can park the focus ring on any button here, Enter belongs to
      // whatever is focused: a Quick idea, Options and History activate themselves (CREATE
      // does too, natively). The CREATE shortcut is only for Enter from a mad-lib field or
      // from nowhere in particular.
      if (e.target && e.target.tagName === 'BUTTON') return;
      if (btnCreate.disabled) return;
      e.preventDefault();
      btnCreate.click();
    });

    // The arrow keys walk the focus ring around the setup screen, so the whole menu - the
    // four mad-lib fields, their Attach buttons, the entire wrapped grid of Quick ideas and
    // the Options / History / CREATE row - is reachable without a mouse or thirty presses of
    // Tab. Movement is geometric, not DOM order: ArrowDown from a Quick idea lands on the one
    // drawn roughly below it, skipping the rest of its row. In a mad-lib field ArrowUp/Down
    // always step out (a one-line field has nowhere for them to go), while ArrowLeft/Right
    // keep moving the caret and only step to the neighbour once it sits at the field's edge -
    // so the Attach button just right of the field is still one arrow away.
    // Every control the arrow keys can land on inside one container. Used for the setup
    // screen and, with the same geometry below, for each dialog box.
    function focusablesIn(root) {
      if (!root) return [];
      // a[href] is here for the About box's profile links - the only real hyperlinks in the
      // app, and they have to be walkable like every other control. .scroll-pane is that same
      // box's wall of text, which takes focus so the arrows can scroll it. Nothing else on
      // screen is either, so this widens nothing in practice.
      return Array.from(root.querySelectorAll('input, select, button, a[href], .scroll-pane')).filter((el) => {
        if (el.disabled || el.type === 'file') return false;
        return el.getClientRects().length > 0;   // on screen: not .hidden, not a collapsed badge
      });
    }

    // Pick the best control to move to. The mad-lib fields aren't left-edge aligned (each is
    // centred in its own row behind a label of its own width), so a plain "nearest in that
    // direction" jumps diagonally - wall straight to weapon, past player. Instead: a candidate
    // that overlaps the current control on the cross axis (same row for L/R, same column band
    // for U/D) always beats one that doesn't; within that, the smallest gap along the pressed
    // axis wins, then the smallest cross-axis offset. L/R never take a non-overlapping
    // candidate at all, so a row end just stops rather than lurching to another row.
    function moveFocusIn(root, dir) {
      const list = focusablesIn(root);
      if (!list.length) return;
      const active = document.activeElement;
      if (list.indexOf(active) === -1) { list[0].focus(); return; }

      const a = active.getBoundingClientRect();
      const horiz = dir === 'left' || dir === 'right';
      const aMidX = (a.left + a.right) / 2;
      const aMidY = (a.top + a.bottom) / 2;

      let best = null;
      let bestKey = null;
      for (const el of list) {
        if (el === active) continue;
        const r = el.getBoundingClientRect();
        const midX = (r.left + r.right) / 2;
        const midY = (r.top + r.bottom) / 2;

        const forward = dir === 'up'   ? aMidY - midY
                      : dir === 'down' ? midY - aMidY
                      : dir === 'left' ? aMidX - midX
                      :                  midX - aMidX;
        if (forward < 1) continue;   // must actually be that way

        const overlap = horiz
          ? (r.bottom > a.top + 1 && r.top < a.bottom - 1)
          : (r.right > a.left + 1 && r.left < a.right - 1);
        if (horiz && !overlap) continue;   // L/R stay on the current row

        const cross = horiz ? Math.abs(midY - aMidY) : Math.abs(midX - aMidX);
        const key = [overlap ? 0 : 1, Math.round(forward), Math.round(cross)];
        if (!bestKey || key[0] < bestKey[0]
            || (key[0] === bestKey[0] && key[1] < bestKey[1])
            || (key[0] === bestKey[0] && key[1] === bestKey[1] && key[2] < bestKey[2])) {
          best = el;
          bestKey = key;
        }
      }
      if (!best) return;
      best.focus({ preventScroll: true });
      // The History list and the Options box both scroll inside themselves, so a cursor that
      // walked past the edge has to be brought back into view. 'nearest' does nothing when
      // the control is already fully visible, which is the setup screen's whole case.
      best.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }

    // Which dialog the arrow keys belong to right now, innermost first: the two confirm
    // boxes sit on top of the window that opened them, so they win while they are up.
    function topmostOpenDialog() {
      const stack = [modalDownloadStopConfirm, modalEndingStopConfirm, modalEndingPlayer, modalEraseConfirm,
                     modalHistoryConfirm, modalLeaveRunConfirm, modalQuitConfirm, modalLoadingExitConfirm,
                     modalHistory, modalSettings, modalAbout];
      return stack.find(m => m && !m.classList.contains('hidden')) || null;
    }

    // Enter opens a focused, closed <select>'s own list by hand, with showPicker() - browsers
    // bind that to Space or a click, not Enter, and Enter is the only key left free once the
    // arrow keys no longer do (below). Nothing here handles a second Enter to close it: measured
    // directly (a document-capture keydown logger, added and pulled again), once that list is
    // genuinely open the browser stops dispatching keydown at all - not Enter, Escape or the
    // arrows reach the page - so there is never a second one for this to see. It reappears, the
    // list already closed, the moment the browser's own Enter/Escape/click ends it.
    window.addEventListener('keydown', (e) => {
      if (e.code !== 'Enter' && e.code !== 'NumpadEnter') return;
      if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
      const active = document.activeElement;
      if (!active || active.tagName !== 'SELECT' || !active.showPicker) return;
      e.preventDefault();
      try { active.showPicker(); } catch (_) { /* not a user gesture - stays focused, closed */ }
    });

    window.addEventListener('keydown', (e) => {
      const dir = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right' }[e.code];
      if (!dir) return;
      if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;   // word-jump / select stay native

      const el = document.activeElement;
      // A dropdown's arrows walk to the next control now, same as everything else below - Enter
      // (above) is how its own list opens instead. Nothing needs to check for that list actually
      // being open: while it is, the browser never dispatches keydown at all (see the comment on
      // the Enter listener), so this line is simply never reached until it has already closed.
      // A slider only owns Left/Right that way; Up/Down fall through to the walk too, so the
      // cursor can move off a slider onto the one above or below it.
      if (el && el.tagName === 'INPUT' && el.type === 'range' && (dir === 'left' || dir === 'right')) return;
      // A pane of text that scrolls inside itself (the About box) owns the arrows the same way,
      // but only until it runs out of text: at the top one more ArrowUp steps off it, at the
      // bottom one more ArrowDown does, so the cursor is never trapped in the prose.
      if (el && el.classList && el.classList.contains('scroll-pane')) {
        const atTop = el.scrollTop <= 0;
        const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
        if ((dir === 'up' && !atTop) || (dir === 'down' && !atBottom)) return;   // let it scroll
      }
      if (el && el.tagName === 'INPUT' && el.type === 'text' && (dir === 'left' || dir === 'right')) {
        const collapsed = el.selectionStart === el.selectionEnd;
        const atEdge = dir === 'left'
          ? collapsed && el.selectionStart === 0
          : collapsed && el.selectionStart === el.value.length;
        if (!atEdge) return;   // move the caret inside the field first
      }

      // A dialog takes the arrows wherever it was opened from - the setup screen, or now
      // straight over a running dungeon - so every box is walkable without the mouse.
      const dialog = topmostOpenDialog();
      if (dialog) {
        e.preventDefault();
        // Nothing focused inside the box yet (it was opened by a key, not a click): start
        // the cursor on the first control rather than swallowing the press.
        if (!dialog.contains(el)) focusFirstIn(dialog);
        else moveFocusIn(dialog, dir);
        return;
      }

      if (!atBaseScreen()) return;
      e.preventDefault();
      // The title bar's ? / □ / ✕ sit outside screenSetup (or, in SHOWCASE_MODE, screenShowcase)
      // in the DOM - appContainer is their common root with it - so the walk widens to
      // appContainer to reach them. That root also covers the loading and game screens, but each
      // is hidden by its own class whenever this one shows, so nothing of theirs enters the list.
      // focusFirstIn still skips the title bar for the very first press, same as it already does
      // opening any dialog.
      if (!appContainer.contains(el)) focusFirstIn(appContainer);
      else moveFocusIn(appContainer, dir);
    });

    // A refresh mid-generation used to be silently destructive in both directions: the page
    // lost the run it was waiting on, and the server carried on feeding ComfyUI a dozen more
    // prompts for a bundle nobody would ever collect. So warn first...
    window.addEventListener('beforeunload', (e) => {
      if (!generationInFlight) return;
      // Browsers show their own fixed wording here and ignore any string we supply; both
      // the preventDefault and the legacy returnValue are needed for full coverage.
      e.preventDefault();
      e.returnValue = 'Creation is still running. Leaving now will cancel it.';
      return e.returnValue;
    });

    // ...and if they leave anyway, tell the server on the way out so it can interrupt the
    // running ComfyUI job and drop the ones still queued. pagehide (not unload, which is
    // deprecated and skipped on some teardown paths) fires only once the user has actually
    // confirmed - cancelling the dialog above never gets here. sendBeacon survives the page
    // dying; fetch+keepalive is the fallback where it doesn't exist.
    window.addEventListener('pagehide', (e) => {
      // persisted means the page went into the back/forward cache and can still come back,
      // so it hasn't really left. (The preventDefault above already makes the page
      // bfcache-ineligible while a run is live, but don't lean on that.)
      if (e.persisted || !generationInFlight) return;
      generationInFlight = false;
      const url = `${SERVER_URL}/api/cancel_generation`;
      // No body, so this stays a CORS-simple POST and needs no preflight the dying page
      // could never complete.
      if (!(navigator.sendBeacon && navigator.sendBeacon(url))) {
        try { fetch(url, { method: 'POST', keepalive: true }); } catch (err) { /* page is going */ }
      }
    });

    // Cancelling is not instant on the server side. The worker only unwinds when it reaches
    // its next checkpoint, and ComfyUI has to be told more than once to drop the job it is
    // already sampling - so for a second or two after the reload the old run is still alive.
    // CREATE pressed into that window would queue a whole second chain behind the dying one,
    // which is the thing the cancel exists to prevent. /api/progress reports `settling` for
    // exactly this: the button waits until the server says it is genuinely clear.
    const btnCreateLabel = btnCreate.querySelector('span');
    const btnCreateText = btnCreateLabel ? btnCreateLabel.textContent : '';
    let settlingWatchActive = false;
    // Set while Fill-in/Randomize all waits on the server. The server handles one request at a
    // time, so a CREATE pressed meanwhile would sit behind the text call - CREATE stays disabled
    // for it, and the settling watcher must not re-enable it early.
    let fillInFlight = false;
    // Non-null while the button is showing a temporary result/error ("✓ All filled", "⚠ Try
    // again") instead of its resting label - syncFillInLabel leaves it alone until that clears.
    // Top-level (not declared inside the button's own wiring below) so syncFillInLabel, called
    // from the setup-history functions far above, can see it too.
    let fillInNoticeTimer = null;

    // The last settling answer, kept so something other than the settling watcher (an ending
    // movie finishing, see paintEndingJobLocks) can repaint CREATE without guessing it.
    let createSettlingNow = false;
    function setCreateSettling(settling) {
      createSettlingNow = !!settling;
      const filming = endingManualFilming();
      btnCreate.disabled = settling || fillInFlight || filming;
      if (btnCreateLabel) {
        btnCreateLabel.textContent = settling ? '⏳ CLEARING...' : filming ? '🎬 FILMING...' : btnCreateText;
      }
      btnCreate.title = settling
        ? 'Still stopping the cancelled run - ComfyUI is being cleared.'
        : filming ? ENDING_FILMING_LOCK_TITLE : '';
    }

    // ---- ComfyUI preflight notice --------------------------------------------------------
    // Asks /api/preflight (comfy_preflight in server.py) whether this machine's ComfyUI can make a
    // dungeon, and lists what it lacks in the notice under the wizard header. Only an early
    // warning: the server refuses CREATE on its own when anything required is missing, which is
    // why nothing here touches CREATE's disabled state (setCreateSettling owns that).
    const preflightNotice = document.getElementById('preflightNotice');
    const preflightTitle = document.getElementById('preflightTitle');
    const preflightList = document.getElementById('preflightList');
    const btnPreflightRecheck = document.getElementById('btnPreflightRecheck');
    const btnPreflightSettings = document.getElementById('btnPreflightSettings');
    const preflightRequired = document.getElementById('preflightRequired');
    const preflightRequiredList = document.getElementById('preflightRequiredList');
    const preflightOptional = document.getElementById('preflightOptional');
    const preflightOptionalList = document.getElementById('preflightOptionalList');

    // The missing models and nodes in a preflight report, one {text, needed} per group or node -
    // `needed` meaning it blocks CREATE. Used by Options' status box; the setup notice itself now
    // gets its model-group lines from the downloadable rows below (renderModelGroups) instead.
    function preflightItems(report) {
      const items = [];
      for (const g of (report && report.groups) || []) {
        if (!g.missing || !g.missing.length) continue;
        const files = g.missing.map((m) => `${m.file} → models/${m.folder}/`).join(', ');
        items.push(g.required ? { text: `${g.label} (needed): ${files}`, needed: true }
                              : { text: `${g.label} (optional - without it, ${g.fallback}): ${files}`, needed: false });
      }
      for (const n of (report && report.nodes) || []) {
        if (n.required && !n.present) items.push({ text: `The ${n.name} node (needed): install ${n.pack}`, needed: true });
      }
      return items;
    }

    // Just the missing-required-node lines - the setup notice's plain-list part, now that missing
    // model files get their own downloadable rows instead of a text line.
    function requiredNodeProblems(report) {
      const items = [];
      for (const n of (report && report.nodes) || []) {
        if (n.required && !n.present) items.push({ text: `The ${n.name} node (needed): install ${n.pack}`, needed: true });
      }
      return items;
    }

    let lastPreflightReport = null;

    function renderPreflight(report) {
      if (!preflightNotice || !preflightList || !preflightTitle) return;
      lastPreflightReport = report;
      let lines = [];
      let title = '';
      const anyMissing = !!(report && report.groups && report.groups.some((g) => g.missing && g.missing.length));
      if (report && report.comfy && report.comfy.error) {
        title = "⛔ ComfyUI isn't ready";
        lines.push(report.comfy.error);
      } else if (report) {
        lines = requiredNodeProblems(report).map((item) => item.text);
        if (lines.length || anyMissing) {
          title = report.ready ? '⚠️ Some optional ComfyUI models are missing'
                               : '⛔ ComfyUI is missing files a dungeon needs';
        }
      }
      preflightTitle.textContent = title;
      preflightList.replaceChildren(...lines.map((text) => {
        const li = document.createElement('li');
        li.textContent = text;
        return li;
      }));
      renderModelGroups(report);
      renderAboutModels(report);
      preflightNotice.classList.toggle('hidden', lines.length === 0 && !anyMissing);
      // Inside ComfyUI (the custom node) there's no connection to set, so no shortcut to it.
      if (btnPreflightSettings) {
        btnPreflightSettings.classList.toggle('hidden', !!(report && report.comfy && report.comfy.embedded));
      }
    }

    // Not disabled while it asks: a disabled button drops the keyboard focus, and Check again is
    // usually pressed from the keyboard. A second press during a check is simply ignored.
    let preflightChecking = false;
    async function checkPreflight() {
      if (preflightChecking) return lastPreflightReport;
      preflightChecking = true;
      if (btnPreflightRecheck) btnPreflightRecheck.setAttribute('aria-busy', 'true');
      let report = null;   // stays null if this server itself didn't answer - nothing to list then
      try {
        report = await (await fetch(`${SERVER_URL}/api/preflight`, { cache: 'no-store' })).json();
      } catch (err) { /* keep null */ }
      preflightChecking = false;
      if (btnPreflightRecheck) btnPreflightRecheck.removeAttribute('aria-busy');
      renderPreflight(report);
      return report;
    }

    if (btnPreflightRecheck) btnPreflightRecheck.addEventListener('click', checkPreflight);
    if (btnPreflightSettings) btnPreflightSettings.addEventListener('click', () => openSettings(comfyFields.url));

    // ---- Model downloads --------------------------------------------------------------------
    // One group (COMFY_MODEL_GROUPS label) downloading at a time, app-wide - see server.py's
    // MODEL_DOWNLOADS / start_model_download_job. downloadJob mirrors endingJob's shape and
    // "keeps reporting its last state" convention (see watchEndingJob above); {state: 'idle'}
    // means nothing is running.
    let downloadJob = { group: null, state: 'idle', file: null, file_index: 0, file_count: 0,
                        percent: 0, bytes_done: 0, bytes_total: 0, error: null };
    let downloadJobWatchTimer = null;
    let downloadJobWatchSeq = 0;
    const DOWNLOAD_JOB_POLL_MS = 1000;   // finer than the ending-video job's - a byte counter is live

    function downloadJobActive(job) {
      const j = job || downloadJob;
      return j.state === 'queued' || j.state === 'downloading';
    }

    // One row per COMFY_MODEL_GROUPS group with something missing, or whose download is active /
    // just failed / was cancelled (a finished, satisfied group renders no row, same as one that
    // was never missing anything). Split into the Required / Optional extras sections so the two
    // are visually obvious rather than one flat list.
    function renderModelGroups(report) {
      if (!preflightRequired || !preflightOptional || !preflightRequiredList || !preflightOptionalList) return;
      const requiredRows = [];
      const optionalRows = [];
      for (const g of (report && report.groups) || []) {
        const jobHere = downloadJob.group === g.label ? downloadJob : null;
        const showJob = !!jobHere && (downloadJobActive(jobHere) || jobHere.state === 'failed' || jobHere.state === 'cancelled');
        if (!g.missing.length && !showJob) continue;
        (g.required ? requiredRows : optionalRows).push(buildModelGroupRow(g, showJob ? jobHere : null));
      }
      preflightRequiredList.replaceChildren(...requiredRows);
      preflightOptionalList.replaceChildren(...optionalRows);
      preflightRequired.classList.toggle('hidden', requiredRows.length === 0);
      preflightOptional.classList.toggle('hidden', optionalRows.length === 0);
    }

    function buildModelGroupRow(g, job) {
      const li = document.createElement('li');
      li.className = 'win95-box p-1.5 bg-white/60 flex flex-col gap-1';

      const head = document.createElement('div');
      head.className = 'flex items-center justify-between gap-2';
      const label = document.createElement('span');
      label.className = 'font-bold';
      label.textContent = g.required ? g.label : `${g.label} — without it, ${g.fallback}`;
      head.appendChild(label);

      const active = !!job && downloadJobActive(job);
      const btn = document.createElement('button');
      btn.className = 'win95-btn px-2 py-0.5 text-[11px] text-black hover:bg-slate-300'
        + (active ? '' : ' bg-slate-200');
      if (active) {
        btn.textContent = 'Cancel';
        btn.addEventListener('click', () => askStopModelDownload(g.label, btn));
      } else {
        const sizeText = historySizeText(g.missing_bytes);
        btn.textContent = (job && job.state === 'failed' ? 'Try Again' : 'Download') + (sizeText ? ` — ${sizeText}` : '');
        btn.disabled = downloadJobActive() && downloadJob.group !== g.label;
        btn.title = btn.disabled ? `Already downloading ${downloadJob.group}.` : '';
        btn.addEventListener('click', () => startModelDownload(g.label));
      }
      head.appendChild(btn);
      li.appendChild(head);

      if (job) {
        const detail = document.createElement('div');
        detail.className = 'text-[11px] text-slate-700 flex items-center justify-between gap-2';
        const text = document.createElement('span');
        text.className = 'truncate flex-1 min-w-0';
        text.textContent = job.state === 'failed' ? (job.error || 'The download failed.')
                          : job.state === 'cancelled' ? 'Stopped — Download picks up where this left off.'
                          : job.file ? `${job.file} (${job.file_index + 1}/${job.file_count})` : '';
        detail.appendChild(text);
        if (active) {
          const pct = document.createElement('strong');
          pct.textContent = `${job.percent || 0}%`;
          detail.appendChild(pct);
        }
        li.appendChild(detail);
        if (active) {
          const trough = document.createElement('div');
          trough.className = 'win95-inset h-2.5 p-0.5 overflow-hidden';
          trough.style.background = '#c0c0c0';
          const fill = document.createElement('div');
          fill.className = 'h-full';
          fill.style.background = '#000080';
          fill.style.width = `${Math.max(0, Math.min(100, job.percent || 0))}%`;
          trough.appendChild(fill);
          li.appendChild(trough);
        }
      }
      return li;
    }

    async function startModelDownload(groupLabel) {
      try {
        const res = await fetch(`${SERVER_URL}/api/model_download_start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ group: groupLabel }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.status === 404) {
          // The page is newer than the server behind it: downloading arrived in an update this
          // ComfyUI (or server.py) hasn't loaded yet - page files are refresh-only, the server isn't.
          const embedded = !!(lastPreflightReport && lastPreflightReport.comfy && lastPreflightReport.comfy.embedded);
          throw new Error(embedded
            ? 'This ComfyUI is still running an older ComfyCrawler. Restart ComfyUI to pick up the update.'
            : "ComfyCrawler's server is still running an older version. Restart server.py to pick up the update.");
        }
        if (data && data.state === 'busy') {
          alert(data.error || 'Already downloading something else - wait for it to finish first.');
        } else if (data && data.state === 'failed') {
          // A refusal the server answered 200 for - no disk space, ComfyUI gone, no such group.
          // Nothing lands in the job, so the row can't show it; say it here or it vanishes.
          throw new Error(data.error || 'The server could not start it.');
        } else if (!res.ok && !(data && data.state)) {
          throw new Error((data && data.error) || 'The server refused.');
        }
      } catch (err) {
        console.error('Model download start error:', err);
        alert('Could not start that download.\n\n' + err.message);
      }
      watchDownloadJob();
    }

    // "Cancel" on a downloading group - an in-page confirm box, not confirm(), same as Stop
    // Filming above: the .part file is kept either way, but a misclick shouldn't throw away
    // network time on a multi-GB file without asking.
    const modalDownloadStopConfirm = document.getElementById('modalDownloadStopConfirm');
    const downloadStopName = document.getElementById('downloadStopName');
    const downloadStopText = document.getElementById('downloadStopText');
    const btnDownloadStopClose = document.getElementById('btnDownloadStopClose');
    const btnDownloadStopKeep = document.getElementById('btnDownloadStopKeep');
    const btnDownloadStopGo = document.getElementById('btnDownloadStopGo');
    let downloadStopPending = null;   // {group, btn} while the box is asking about a download

    function askStopModelDownload(groupLabel, btn) {
      if (!modalDownloadStopConfirm) return;
      downloadStopPending = { group: groupLabel, btn: btn || null };
      if (downloadStopName) downloadStopName.textContent = groupLabel;
      modalDownloadStopConfirm.classList.remove('hidden');
      paintStopModelDownload();
      focusFirstIn(modalDownloadStopConfirm, btnDownloadStopKeep);
    }

    // Keeps the box's progress line current while it is up, and takes it down on its own if the
    // download it is asking about stops being active - it finished, or failed - since there is
    // then nothing left to stop.
    function paintStopModelDownload() {
      if (!downloadStopPending || !modalDownloadStopConfirm
          || modalDownloadStopConfirm.classList.contains('hidden')) return;
      if (!(downloadJobActive() && downloadJob.group === downloadStopPending.group)) {
        closeStopModelDownload();
        return;
      }
      if (!downloadStopText) return;
      const pct = Math.max(0, Math.min(99, downloadJob.percent || 0));
      downloadStopText.textContent = `It is ${pct}% done. The part already downloaded is kept, so `
        + 'pressing Download again picks up where this left off.';
    }

    function closeStopModelDownload() {
      const wasOpen = modalDownloadStopConfirm && !modalDownloadStopConfirm.classList.contains('hidden');
      const back = downloadStopPending && downloadStopPending.btn;
      downloadStopPending = null;
      if (modalDownloadStopConfirm) modalDownloadStopConfirm.classList.add('hidden');
      if (!wasOpen) return;
      if (back && back.isConnected && !back.disabled) back.focus({ preventScroll: true });
    }

    async function confirmStopModelDownload() {
      const pending = downloadStopPending;
      if (!pending) { closeStopModelDownload(); return; }
      try {
        const res = await fetch(`${SERVER_URL}/api/model_download_cancel`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ group: pending.group }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) throw new Error(data.error || 'The server refused.');
      } catch (err) {
        console.error('Stop download error:', err);
        alert('Could not stop that download.\n\n' + err.message);
      }
      closeStopModelDownload();
      watchDownloadJob();
    }

    if (btnDownloadStopClose) btnDownloadStopClose.addEventListener('click', closeStopModelDownload);
    if (btnDownloadStopKeep) btnDownloadStopKeep.addEventListener('click', closeStopModelDownload);
    if (btnDownloadStopGo) btnDownloadStopGo.addEventListener('click', confirmStopModelDownload);
    if (modalDownloadStopConfirm) {
      modalDownloadStopConfirm.addEventListener('click', (e) => {
        if (e.target === modalDownloadStopConfirm) closeStopModelDownload();
      });
    }

    // Follows the one model download until it stops being active, then puts the row back and (on
    // a clean finish) lets onDownloadJobFinished auto-enable whatever Option it just unlocked.
    // Started at page load (a reload mid-download) and by every Download press.
    async function watchDownloadJob() {
      if (downloadJobWatchTimer) { clearTimeout(downloadJobWatchTimer); downloadJobWatchTimer = null; }
      const seq = ++downloadJobWatchSeq;
      let next = null;
      try {
        const res = await fetch(`${SERVER_URL}/api/model_download_job`);
        next = await res.json();
      } catch (err) {
        next = null;   // server away for a moment
      }
      if (seq !== downloadJobWatchSeq) return;   // a newer check is already on its way
      const before = downloadJob;
      if (next) downloadJob = next;
      if (downloadJobActive(before) && !downloadJobActive()) {
        onDownloadJobFinished(downloadJob);
      }
      paintStopModelDownload();
      renderModelGroups(lastPreflightReport);
      if (next ? downloadJobActive() : downloadJobActive(before)) {
        downloadJobWatchTimer = setTimeout(watchDownloadJob, DOWNLOAD_JOB_POLL_MS);
      }
    }

    // The actual point of this feature: finishing an optional group's download turns on the
    // Option it unlocks, so the player doesn't have to find it in Options themselves.
    async function onDownloadJobFinished(job) {
      if (job.state !== 'done') { checkPreflight(); return; }
      const report = await checkPreflight();
      const satisfied = (label) => {
        const g = report && report.groups && report.groups.find((x) => x.label === label);
        return !!g && g.missing.length === 0;
      };
      if (job.group === 'Ending video' && !endingVideoOn) {
        endingVideoOn = true;
        paintEndingOptionRows();
        saveEndingOptions();
      } else if (job.group === 'Sound effects' || job.group === 'Music') {
        raiseSoundMode(satisfied('Sound effects') ? (satisfied('Music') ? 2 : 1) : 0);
      }
    }

    // ---- About > What is on this disk -------------------------------------------------------
    // The parts list in the About box, made checkable: every file COMFY_MODEL_GROUPS names,
    // whether this machine's ComfyUI can actually see it, and the folder it belongs in. Reads
    // the same /api/preflight report the setup notice does - the report now carries `files` per
    // group, not only `missing` - so a download finishing on the main menu repaints this too.
    // Nothing here downloads: the setup panel owns that, and the note under the heading says so.
    const aboutModelsList = document.getElementById('aboutModelsList');
    const btnAboutModelsRecheck = document.getElementById('btnAboutModelsRecheck');

    function renderAboutModels(report) {
      if (!aboutModelsList) return;
      const groups = (report && report.groups) || [];
      if (!groups.length) {
        const line = document.createElement('div');
        line.className = 'text-[11px] font-bold text-orange-800';
        line.textContent = report ? "ComfyUI didn't say what it has - press Check again."
                                  : "ComfyCrawler's own server didn't answer, so nothing could be checked.";
        aboutModelsList.replaceChildren(line);
        return;
      }
      const rows = groups.map(buildAboutModelGroup);
      // Every file in every group reads "not checked" when ComfyUI can't be reached - accurate,
      // but five of those in a row with no reason looks exactly like a stuck button. Say why,
      // above the list, using the same error the setup notice already shows.
      if (report.comfy && report.comfy.reachable === false) {
        const banner = document.createElement('div');
        banner.className = 'win95-box p-1.5 bg-white/60 text-[11px] font-bold text-orange-800';
        banner.textContent = '⛔ ' + (report.comfy.error || "ComfyUI can't be reached right now.")
          + ' Folders below still open - the checkmarks just can’t be verified until it answers.';
        rows.unshift(banner);
      }
      aboutModelsList.replaceChildren(...rows);
    }

    // One COMFY_MODEL_GROUPS group: its name, a tally, and a row per file. `present` is null
    // when ComfyUI never answered - then the tally says so rather than calling every file
    // missing, which would be a lie about the disk.
    function buildAboutModelGroup(g) {
      const box = document.createElement('div');
      box.className = 'flex flex-col gap-0.5';
      const files = g.files || [];
      const checked = files.some((f) => f.present === true || f.present === false);
      const here = files.filter((f) => f.present === true).length;

      const head = document.createElement('div');
      head.className = 'flex items-baseline justify-between gap-2';
      const label = document.createElement('span');
      label.className = 'text-[11px] font-black text-slate-900';
      label.textContent = g.label;
      head.appendChild(label);
      const tally = document.createElement('span');
      tally.className = 'text-[10px] font-bold shrink-0 '
        + (!checked ? 'text-slate-500' : here === files.length ? 'text-green-800' : 'text-orange-800');
      tally.textContent = !checked ? 'not checked'
                        : here === files.length ? 'all here'
                        : `${here} of ${files.length} here`;
      head.appendChild(tally);
      box.appendChild(head);

      const sub = document.createElement('div');
      sub.className = 'text-[10px] font-bold text-slate-600';
      sub.textContent = g.required ? 'Needed - a dungeon cannot be made without these.'
                                   : `Optional - without it, ${g.fallback}.`;
      box.appendChild(sub);

      for (const f of files) box.appendChild(buildAboutModelRow(f));
      return box;
    }

    // A file, as a button onto the folder it belongs in - present or not, since "where would it
    // go?" is the question a missing one raises. openServerFolder takes a KEY, so what travels is
    // "model:diffusion_models" plus the filename, never a path (server.py MODEL_FOLDER_NAMES /
    // MODEL_FILES_BY_FOLDER) - the filename is what lets the server open the search path that
    // actually holds THIS file when its folder type has more than one.
    function buildAboutModelRow(f) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'about-model text-[11px]' + (f.present === false ? ' is-missing' : '');

      const tick = document.createElement('span');
      tick.className = 'select-none';
      tick.textContent = f.present === true ? '✅' : f.present === false ? '❌' : '❔';
      row.appendChild(tick);

      const name = document.createElement('span');
      name.className = 'about-model-file';
      name.textContent = f.file;
      row.appendChild(name);

      const size = document.createElement('span');
      size.className = 'about-model-size';
      size.textContent = historySizeText(f.bytes);
      row.appendChild(size);

      // The real directory when ComfyUI named one (extra_model_paths.yaml can move it), else the
      // stock layout, which is where it would land anyway.
      const dir = document.createElement('span');
      dir.className = 'about-model-dir';
      dir.textContent = f.dir || `models/${f.folder}/`;
      row.appendChild(dir);

      const where = f.dir || `ComfyUI's ${f.folder} folder`;
      row.title = f.present === false ? `Missing. Open ${where}, where it goes.`
                : f.present === true ? `Installed. Open ${where}.`
                : `Open ${where}.`;
      row.addEventListener('click', () => openServerFolder(`model:${f.folder}`, f.file));
      return row;
    }

    // The box asks for itself every time it opens: the last report can be minutes old, or from
    // before a download finished. Paints what is already known first so the list is never blank
    // while the check is in flight.
    async function refreshAboutModels() {
      renderAboutModels(lastPreflightReport);
      if (btnAboutModelsRecheck) btnAboutModelsRecheck.setAttribute('aria-busy', 'true');
      await checkPreflight();          // renderPreflight repaints this list when it lands
      if (btnAboutModelsRecheck) btnAboutModelsRecheck.removeAttribute('aria-busy');
    }

    if (btnAboutModelsRecheck) btnAboutModelsRecheck.addEventListener('click', refreshAboutModels);

    // ---- Options > ComfyUI Connection -------------------------------------------------------
    // Where ComfyCrawler finds ComfyUI (server.py COMFYUI CONNECTION). A blank field is detected
    // automatically; a typed value overrides just that one and is saved by the server
    // (comfy_settings.json), since the server is what connects. Apply - or Enter in a field, or
    // OK with edits still unapplied - saves and re-checks at once, and the answer lands in the
    // status box and the setup notice alike. ✕ / ESC leave edits unsaved, like Cancel; the next
    // open reloads what is really saved.
    const comfyStatusSummary = document.getElementById('comfyStatusSummary');
    const comfyStatusDetails = document.getElementById('comfyStatusDetails');
    const btnComfyDetails = document.getElementById('btnComfyDetails');
    const comfyFields = {
      url: document.getElementById('comfyUrlInput'),
      input_dir: document.getElementById('comfyInputDirInput'),
      output_dir: document.getElementById('comfyOutputDirInput'),
      models_dir: document.getElementById('comfyModelsDirInput'),
    };
    const comfySettingsFields = document.getElementById('comfySettingsFields');
    const btnComfyAuto = document.getElementById('btnComfyAuto');
    const btnComfyApply = document.getElementById('btnComfyApply');
    let comfySaved = null;     // what the server last said is saved - what "unapplied edits" compare to
    let comfyRequest = 0;      // a newer load or apply supersedes a reply still on its way

    // The first line is the headline and is all that shows collapsed; the report pane below it
    // holds the rest, so opening it repeats nothing. Both keep their height whatever the check is
    // doing - a headline with nothing under it still gets a pane, so the dialog never moves.
    const COMFY_SUMMARY_CLASS = 'flex-1 min-w-0 truncate';

    function setComfyStatus(lines) {
      const [summaryText, summaryCls] = lines[0] || ['', ''];
      if (comfyStatusSummary) {
        comfyStatusSummary.textContent = summaryText;
        comfyStatusSummary.className = summaryCls ? `${COMFY_SUMMARY_CLASS} ${summaryCls}` : COMFY_SUMMARY_CLASS;
        comfyStatusSummary.title = summaryText;
      }
      if (!comfyStatusDetails) return;
      const rest = lines.slice(1);
      // A headline too long for its one line has to stay readable somewhere, so when it clips the
      // pane carries it in full. Refusals are the long ones, and they are the ones that explain
      // how to put it right. A headline that fits is never repeated.
      if (comfyStatusSummary && comfyStatusSummary.clientWidth
          && comfyStatusSummary.scrollWidth > comfyStatusSummary.clientWidth) {
        rest.unshift([summaryText, summaryCls]);
      }
      if (!rest.length) rest.push(['No further detail.', 'text-slate-500']);
      comfyStatusDetails.replaceChildren(...rest.map(([text, cls]) => {
        const div = document.createElement('div');
        div.textContent = text;
        if (cls) div.className = cls;
        return div;
      }));
    }

    function setComfyDetailsOpen(open) {
      if (!comfyStatusDetails || !btnComfyDetails) return;
      comfyStatusDetails.classList.toggle('hidden', !open);
      btnComfyDetails.textContent = open ? '▲' : '▼';
      btnComfyDetails.setAttribute('aria-expanded', open ? 'true' : 'false');
      btnComfyDetails.title = open ? 'Hide the full ComfyUI report' : 'Show the full ComfyUI report';
    }

    if (btnComfyDetails) {
      btnComfyDetails.addEventListener('click', () => {
        setComfyDetailsOpen(btnComfyDetails.getAttribute('aria-expanded') !== 'true');
      });
    }

    // The field values when a load or apply started. A reply only refills a field still holding
    // that value - with ComfyUI down the check can take seconds, and whatever was typed meanwhile
    // must not be wiped by the answer to an older question.
    function comfyFieldSnapshot() {
      return Object.fromEntries(Object.entries(comfyFields).map(([key, input]) => [key, input ? input.value : '']));
    }

    function renderComfyView(view, before) {
      const report = view.preflight;
      const c = report.comfy;
      comfySaved = { ...view.settings };
      // Running inside ComfyUI: the fields and buttons have nothing to change, so only the status shows.
      if (comfySettingsFields) comfySettingsFields.classList.toggle('hidden', !!view.embedded);
      const from = (key) => {
        const source = c.sources && c.sources[key];
        return source === 'comfyui' ? 'running inside ComfyUI'
             : source === 'env' ? `set by ${view.env_names[key]}` : source === 'options' ? 'set here' : 'found automatically';
      };
      for (const [key, input] of Object.entries(comfyFields)) {
        if (!input) continue;
        const pinned = !!view.env[key];
        input.disabled = pinned;
        if (pinned || !before || input.value === before[key]) input.value = pinned ? '' : (view.settings[key] || '');
        const found = !c.error && c.sources && c.sources[key] === 'auto' ? c[key] : null;
        input.placeholder = pinned ? `Set by ${view.env_names[key]}` : found ? `Auto-detect (found ${found})` : 'Auto-detect';
        input.title = pinned ? `The ${view.env_names[key]} environment variable sets this, and wins over anything typed here.`
                             : 'Leave blank to find it automatically.';
      }
      if (c.error) {
        setComfyStatus([[`✖ ${c.error}`, 'text-red-800 font-bold']]);
      } else {
        const items = preflightItems(report);
        setComfyStatus([
          [`✔ ComfyUI ${c.version || ''} at ${c.url} (${from('url')})`, 'font-bold'],
          [`Input: ${c.input_dir} (${from('input_dir')})`, ''],
          [`Output: ${c.output_dir} (${from('output_dir')})`, ''],
          ...(items.length ? items.map((item) => [`• ${item.text}`, item.needed ? 'text-red-800' : ''])
                           : [['✔ Every model and node a dungeon uses is installed.', '']]),
        ]);
      }
      renderPreflight(report);
    }

    async function loadComfySettings() {
      const mine = ++comfyRequest;
      const before = comfyFieldSnapshot();
      setComfyStatus([['Checking ComfyUI...', '']]);
      try {
        const view = await (await fetch(`${SERVER_URL}/api/comfy_settings`, { cache: 'no-store' })).json();
        if (mine === comfyRequest) renderComfyView(view, before);
      } catch (err) {
        if (mine === comfyRequest) setComfyStatus([["✖ Couldn't reach the ComfyCrawler server.", 'text-red-800 font-bold']]);
      }
    }

    function comfyEditsPending() {
      if (!comfySaved) return false;
      return Object.entries(comfyFields).some(([key, input]) =>
        input && !input.disabled && input.value.trim() !== (comfySaved[key] || ''));
    }

    // Saves the fields and re-checks. Resolves true when saved (even if ComfyUI then can't be
    // reached - the status box says so), false when the server refused the values, and undefined
    // when a newer request took over.
    async function applyComfySettings() {
      const mine = ++comfyRequest;
      const before = comfyFieldSnapshot();
      const payload = {};
      for (const [key, input] of Object.entries(comfyFields)) {
        // A field an environment variable pins keeps whatever Options had saved underneath it.
        payload[key] = input && !input.disabled ? input.value : ((comfySaved && comfySaved[key]) || '');
      }
      setComfyStatus([['Saving and checking ComfyUI...', '']]);
      try {
        const res = await fetch(`${SERVER_URL}/api/comfy_settings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const view = await res.json();
        if (mine !== comfyRequest) return undefined;
        if (!res.ok || !view.success) {
          // The typed values stay in the fields, so they can be corrected.
          setComfyStatus([[`✖ ${view.error || 'The server refused the change.'}`, 'text-red-800 font-bold']]);
          return false;
        }
        renderComfyView(view, before);
        return true;
      } catch (err) {
        if (mine !== comfyRequest) return undefined;
        setComfyStatus([["✖ Couldn't reach the ComfyCrawler server.", 'text-red-800 font-bold']]);
        return false;
      }
    }

    for (const input of Object.values(comfyFields)) {
      if (!input) continue;
      input.addEventListener('keydown', (e) => {
        if (e.code !== 'Enter' && e.code !== 'NumpadEnter') return;
        e.preventDefault();
        applyComfySettings();
      });
    }
    if (btnComfyApply) btnComfyApply.addEventListener('click', () => { applyComfySettings(); });
    if (btnComfyAuto) btnComfyAuto.addEventListener('click', () => {
      for (const input of Object.values(comfyFields)) {
        if (input && !input.disabled) input.value = '';
      }
      setComfyStatus([['Fields emptied - press Apply to find ComfyUI automatically.', 'font-bold']]);
      if (btnComfyApply) btnComfyApply.focus({ preventScroll: true });
    });

    // Polls one request at a time (not on an interval) so a slow reply can never stack up,
    // and returns as soon as the server is free. Safe to call whenever CREATE might be
    // pressed; a second call while one is already running is a no-op.
    async function watchForSettling() {
      if (settlingWatchActive) return;
      settlingWatchActive = true;
      try {
        for (;;) {
          let settling = false;
          try {
            const res = await fetch(`${SERVER_URL}/api/progress`);
            settling = !!(await res.json()).settling;
          } catch (err) {
            // No server to wait on. Never strand the button disabled over a failed poll.
            settling = false;
          }
          setCreateSettling(settling);
          if (!settling) return;
          await new Promise(r => setTimeout(r, 500));
        }
      } finally {
        settlingWatchActive = false;
      }
    }

    // ---- Fill-in / Randomize all: write mad-lib fields to go with what is already typed -----
    // Any field empty (and at least one filled) -> Fill-in: only the gaps are written, around
    // whatever is already there. Every field already filled -> the button reads "Randomize all"
    // instead, and a click replaces all four with a whole new set, the same way a Quick idea
    // does. All four empty is Fill-in too, and the server invents a whole set for that same
    // reason - the two only differ once something is typed. A field with a photo attached is
    // disabled and counts as filled either way - the photo is the answer for that line, and
    // this never overwrites it or asks the model to replace it, only to write around it.
    const btnFillIn = document.getElementById('btnFillIn');
    if (btnFillIn) {
      const btnFillInLabel = btnFillIn.querySelector('span');

      const fieldIsOpen = (el) => !el.disabled && !el.value.trim();
      const allFieldsFilled = () => SETUP_TEXT_FIELDS.every(([, el]) => el.disabled || el.value.trim());

      // A short word on the button itself, then back to whichever resting label fits the fields
      // now - the setup row has no spare line for a message, and adding one would wrap it.
      const flashFillIn = (label, title) => {
        clearTimeout(fillInNoticeTimer);
        if (btnFillInLabel) btnFillInLabel.textContent = label;
        btnFillIn.title = title;
        fillInNoticeTimer = setTimeout(() => {
          fillInNoticeTimer = null;
          syncFillInLabel();
        }, 2500);
      };

      btnFillIn.addEventListener('click', async () => {
        if (fillInFlight) return;
        // Decided once, up front: everything below - what gets sent, the in-flight label, and
        // which fields the reply is allowed to overwrite - follows this same call's answer, even
        // if typing during the wait would have changed it.
        const randomize = allFieldsFilled();
        const fields = {};
        SETUP_TEXT_FIELDS.forEach(([key, el]) => {
          // A photo-filled field is described rather than blank either way, so the model still
          // writes the other fields to go with it instead of inventing a hero that gets thrown
          // away. Otherwise: Randomize all blanks every field out to ask for a whole new set;
          // Fill-in sends each one as it stands, so only its own gaps come back.
          fields[key] = el.disabled ? (el.value.trim() || 'an attached photo')
                                    : (randomize ? '' : el.value.trim());
        });

        fillInFlight = true;
        clearTimeout(fillInNoticeTimer);
        fillInNoticeTimer = null;
        btnFillIn.disabled = true;
        btnFillIn.title = '';
        if (btnFillInLabel) btnFillInLabel.textContent = randomize ? '⏳ Randomizing...' : '⏳ Filling...';
        setCreateSettling(false);   // fillInFlight holds it disabled

        let reply = null;
        let error = null;
        try {
          const res = await fetch(`${SERVER_URL}/api/fill_in`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(fields),
          });
          try { reply = await res.json(); } catch (err) { /* not JSON */ }
          if (!res.ok || !reply || !reply.success) {
            error = (reply && reply.error) || 'The server could not fill these in.';
          }
        } catch (err) {
          error = 'Could not reach the server.';
        } finally {
          fillInFlight = false;
          btnFillIn.disabled = endingManualFilming();
          setCreateSettling(false);
          watchForSettling();   // puts CREATE back the way the server actually is
        }

        if (screenSetup.classList.contains('hidden')) { syncFillInLabel(); return; }   // left the menu meanwhile
        if (error) { flashFillIn('⚠ Try again', error); return; }

        const got = (reply && reply.fields) || {};
        let firstFilled = null;
        asOneSetupStep(() => {
          SETUP_TEXT_FIELDS.forEach(([key, el]) => {
            if (!got[key] || el.disabled) return;
            // Fill-in only ever writes into a field still empty on arrival, so anything typed
            // while waiting survives; Randomize all replaces every field regardless, same as a
            // Quick idea, which is the point of asking for it by name.
            if (!randomize && !fieldIsOpen(el)) return;
            el.value = got[key];
            if (!firstFilled) firstFilled = el;
          });
        });
        if (firstFilled) {
          firstFilled.focus({ preventScroll: true });
        } else {
          flashFillIn('⚠ Try again', 'The idea writer came back empty - press the button again.');
        }
      });

      syncFillInLabel();   // set the resting label for whatever the fields hold on page load
    }

    btnCreate.addEventListener('click', async () => {
      if (SHOWCASE_MODE) return;   // no server to generate anything with in this export
      const wallStyle = wallPromptInput.value.trim() || "Windows 95";
      // A quoted name ("alley pond park") is a server-side marker, not display text - strip it
      // here so a fallback title (used only when the story itself has no location) never shows a
      // stray quote mark.
      currentThemeName = wallStyle.replace(/["“”]/g, "");
      activeMode = 'v6_krea';   // engine mode picker removed - v6 is the only engine now
      const numGrids = (DIFFICULTIES[selectedDifficulty] || DIFFICULTIES.medium).grids;

      // Start every dungeon from a clean slate. Quitting straight from an active battle (without
      // pressing Space to leave battle mode first) used to carry that fight's drained stamina,
      // damage and held keys into the new dungeon.
      resetCombatForNewDungeon();

      resetCrawl();
      generationInFlight = true;
      screenSetup.classList.add('hidden');
      screenProgress.classList.remove('hidden');
      // The title bar stays up on the loading screen - the stylesheet trims it to ? and ✕
      // there, and that ✕ is how a run is called off without reloading the page.
      appContainer.className = 'win95-box p-1 text-black mode-progress';

      generateAuthentic3DMaze(numGrids);
      buildExitStairsTexture(wallStyle, wallTexture);

      const startTime = Date.now();
      progTimer.textContent = "0.0s";
      setTabTitlePercent(0);
      genClockTimer = setInterval(() => {
        progTimer.textContent = ((Date.now() - startTime) / 1000).toFixed(1) + "s";
      }, 100);

      try {
        const startRes = await fetch(`${SERVER_URL}/api/generate_dungeon`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            wall_style: wallStyle,
            player_style: playerPromptInput ? playerPromptInput.value.trim() : "",
            player_image: uploadedPlayerImageDataUrl || null,
            weapon_style: weaponPromptInput ? weaponPromptInput.value.trim() : "",
            weapon_image: attachedImages.weapon || null,
            enemy_style: enemyPromptInput ? enemyPromptInput.value.trim() : "",
            enemy_image: attachedImages.enemy || null,
            mode: activeMode,
            sound_mode: soundModeSelect ? soundModeSelect.value : 'music_and_sound',
            graphics_quality: gfxQualitySelect ? gfxQualitySelect.value : 'normal',
            // One more frame per foe, shown when its blow lands - see lastAttackFrameMode. Quick
            // needs nothing generated, so only 'on' asks for it.
            last_attack_frame: lastAttackFrameMode === 'on',
            // The ending cutscene, and whether it is filmed on this loading screen or in the
            // background once the run starts - see the ENDING CUTSCENE section.
            ending_video: endingVideoOn,
            ending_video_background: endingVideoOn && endingBackgroundOn
          })
        });

        // 409 means the server refused to start: a previous run is still being cleared
        // (run_is_settling), an ending movie is filming, or the preflight found ComfyUI can't
        // make this dungeon. Back out to setup rather than sitting on a progress screen nothing
        // will ever feed, and let the watcher re-enable CREATE once the server is actually free.
        if (!startRes.ok) {
          let msg = 'The server is still clearing the previous run - try again in a moment.';
          try {
            const refusal = await startRes.json();
            msg = refusal.error || msg;
            // A preflight refusal carries the whole report - bring the setup notice up to date.
            if (refusal.preflight) renderPreflight(refusal.preflight);
          } catch (err) { /* not JSON */ }
          stopGenerationTimers();
          generationInFlight = false;
          resetCrawl();
          resetTabTitle();
          screenProgress.classList.add('hidden');
          screenSetup.classList.remove('hidden');
          if (titleButtons) titleButtons.classList.remove('hidden');
          appContainer.className = 'win95-box p-1 text-black mode-setup w-full';
          watchForSettling();
          alert(msg);
          return;
        }

        genPollTimer = setInterval(async () => {
          try {
            const res = await fetch(`${SERVER_URL}/api/progress`);
            const p = await res.json();

            progStatusText.textContent = p.status_message;
            progPercentText.textContent = p.percent + "%";
            setTabTitlePercent(p.percent);
            // Live sub-job detail ("slash2 - step 5/8"), shown inline between the status
            // message and the percent rather than on its own centered line below.
            if (p.phase) progPhaseText.textContent = p.phase;

            // The story lands minutes ahead of the art - start reading immediately.
            if (p.story && !crawlStarted) startCrawl(p.story);

            paintProgressChunks(p.percent);

            if (!p.is_generating && p.completed_bundle) {
              stopGenerationTimers();
              generationInFlight = false;
              currentRunHistoryId = p.completed_bundle.history_id || null;
              currentRunFavorite = false;   // a freshly generated run has never been starred
              armEnterDungeon(p.completed_bundle);
            } else if (p.error) {
              stopGenerationTimers();
              generationInFlight = false;
              alert("Error: " + p.error);
              resetCrawl();
              resetTabTitle();
              screenProgress.classList.add('hidden');
              screenSetup.classList.remove('hidden');
              if (titleButtons) titleButtons.classList.remove('hidden');
              appContainer.className = 'win95-box p-1 text-black mode-setup w-full';
            }
          } catch (err) {
            console.error('Progress poll error:', err);
          }
        }, 600);

      } catch (err) {
        stopGenerationTimers();
        generationInFlight = false;
        alert('Server communication error. Make sure server.py is running!');
        resetCrawl();
        resetTabTitle();
        screenProgress.classList.add('hidden');
        screenSetup.classList.remove('hidden');
        if (titleButtons) titleButtons.classList.remove('hidden');
        appContainer.className = 'win95-box p-1 text-black mode-setup w-full';
      }
    });


    // ==========================================
    // HISTORY - replaying a dungeon that was already generated
    // ==========================================
    // The server keeps every finished bundle under dungeon_sessions/ (see
    // save_dungeon_session in server.py). This window lists them and starts one straight
    // from disk: no ComfyUI, no waiting, so the loading screen arrives already finished -
    // the crawl runs, the narrator speaks, and ENTER is live from the first frame.
    //
    // What is NOT stored is the maze. A replay re-rolls the layout at whatever difficulty
    // is currently selected, so the same cast and art still give a genuinely new dungeon.

    // The last listing fetched from the server. null means the fetch itself failed, which
    // is a different row than "you have not made any dungeons yet".
    let historyEntries = [];
    // The entry the confirm box is currently asking about, or null.
    let historyPendingDelete = null;
    // Set by openHistory when a run is live behind the window, consumed by the next
    // renderHistoryList: scroll that run's row into view and flash it. Only on the way in - a
    // later rebuild (after a delete, say) leaves the list where the player left it.
    let historyRevealCurrent = false;

    // ---- SHOWCASE_MODE: per-visitor favorite/beaten, kept in this browser instead of on a
    // server that does not exist in this export. Overwrites the manifest's own favorite/beaten
    // on every load (see applyShowcaseOverlay) rather than merging, so a visitor never inherits
    // progress the curator made while testing - the whole point of "beaten" gating the ending
    // movie's spoiler lock is that it means YOU beat it.
    const showcaseState = (() => {
      const KEY = 'comfycrawler.showcase.v1';
      function readAll() {
        try {
          const parsed = JSON.parse(localStorage.getItem(KEY) || '{}');
          return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
        } catch (_) { return {}; }
      }
      function writeAll(all) {
        try { localStorage.setItem(KEY, JSON.stringify(all)); }
        catch (_) { /* private mode, full, etc. - state just won't survive a reload */ }
      }
      return {
        get(id) {
          const rec = readAll()[id];
          return { favorite: !!(rec && rec.favorite), beaten: !!(rec && rec.beaten) };
        },
        setFavorite(id, favorite) {
          const all = readAll();
          all[id] = { ...(all[id] || {}), favorite: !!favorite };
          writeAll(all);
          return !!favorite;
        },
        setBeaten(id) {
          const all = readAll();
          all[id] = { ...(all[id] || {}), beaten: true };   // never unset, same rule the server follows
          writeAll(all);
        },
      };
    })();

    // Stamps this browser's own favorite/beaten over whatever the manifest shipped with -
    // unconditionally, never merged in only when localStorage has nothing. The manifest's
    // values are the curator's own (quite possibly "beaten" on every entry, from testing before
    // publishing), and a merge that let those through would defeat the spoiler lock for every
    // visitor on arrival.
    function applyShowcaseOverlay(entries) {
      if (!Array.isArray(entries)) return;
      entries.forEach(entry => {
        const local = showcaseState.get(entry.id);
        entry.favorite = local.favorite;
        entry.beaten = local.beaten;
      });
    }

    // The showcase gallery is screenShowcase's landing list - the same rows History builds,
    // just rendered inline as the first thing a visitor sees instead of behind a modal. Kept
    // separate from renderHistoryList rather than folding a mode flag into it: that function
    // also carries the "Similar only" filter and the scroll-to-current-run behaviour, both
    // meaningless with no live run or mad-lib draft to compare against.
    function renderShowcaseList() {
      if (!showcaseList) return;
      if (!Array.isArray(historyEntries) || !historyEntries.length) {
        showcaseList.innerHTML = '';
        const msg = document.createElement('div');
        msg.className = 'text-xs text-slate-500 font-bold text-center py-8 px-4';
        msg.textContent = historyEntries === null
          ? 'Could not load the saved dungeons.'
          : 'No dungeons in this showcase yet.';
        showcaseList.appendChild(msg);
        if (showcaseFootNote) showcaseFootNote.textContent = '';
        return;
      }
      showcaseList.innerHTML = '';
      historyEntries.forEach(entry => showcaseList.appendChild(buildHistoryEntryEl(entry)));
      requestAnimationFrame(() => {
        showcaseList.querySelectorAll('.hist-meta').forEach(marqueeIfOverflowing);
      });
      if (showcaseFootNote) {
        const favorites = historyEntries.filter(e => e.favorite).length;
        showcaseFootNote.textContent = historyEntries.length + ' dungeon' + (historyEntries.length === 1 ? '' : 's')
          + (favorites ? '  ·  ' + favorites + ' favorite' + (favorites === 1 ? '' : 's') : '');
      }
    }

    function historyTitleOf(entry) {
      return ((entry && (entry.location || entry.wall_style)) || 'Unnamed Dungeon').trim();
    }

    function historySizeText(bytes) {
      if (!bytes) return '';
      const mb = bytes / 1048576;
      return mb >= 1024 ? (mb / 1024).toFixed(1) + ' GB' : mb.toFixed(1) + ' MB';
    }

    // A single centered line in the list area - loading, empty, or an error.
    function setHistoryMessage(text) {
      if (!historyList) return;
      historyList.innerHTML = '';
      const msg = document.createElement('div');
      msg.className = 'text-xs text-slate-500 font-bold text-center py-8 px-4';
      msg.textContent = text;
      historyList.appendChild(msg);
    }

    // A row's info line lists more than usually fits - wall style, date, size, quality
    // tier, music - so a long one (the "windows 95 3d maze" kind) clips to an ellipsis and
    // hides its tail. If the text genuinely overflows its column, rewrap it as a marquee
    // that scrolls the whole line past on a loop. Called once per line after the list is
    // in the DOM, so scrollWidth/clientWidth are real.
    //
    // Deliberately NOT gated on prefers-reduced-motion. Nothing else here is - the intro
    // crawl aside, the confetti, the starfield and the screensaver's own story marquee all
    // run regardless - and Windows ships plenty of machines with "Show animations" off, so
    // the gate only ever meant a line clipped with no way to read the rest of it.
    function marqueeIfOverflowing(el) {
      if (!el || !el.clientWidth) return;
      if (el.scrollWidth - el.clientWidth <= 1) return;   // fits - leave the plain line
      const text = el.textContent;
      el.classList.remove('truncate');
      el.classList.add('hist-marquee');
      el.textContent = '';
      const track = document.createElement('div');
      track.className = 'hist-marquee__track';
      const a = document.createElement('span');
      a.textContent = text;
      const b = document.createElement('span');
      b.textContent = text;
      b.setAttribute('aria-hidden', 'true');   // screen readers read the line once
      track.append(a, b);
      el.appendChild(track);
      // One copy (its text plus the 2.75rem trailing gap the CSS adds) passes per loop.
      // Pace by that width so a short line and a long one crawl at the same ~55 px/s.
      const copyW = a.getBoundingClientRect().width;
      el.style.setProperty('--mq-dur', Math.max(5, copyW / 55).toFixed(1) + 's');
    }

    // Every string on a row came out of a language model, so all of it goes in through
    // textContent - the list is built node by node rather than as an HTML string.
    // The order the set designer's slots are shown in on the history hover - matches
    // THEME_SURFACE_SLOTS + THEME_SUBJECT_SLOTS in server.py. A bucketed theme only carries
    // the last two.
    const THEME_BRIEF_ORDER = ['wall', 'floor', 'ceiling', 'lantern', 'door', 'switch',
                               'weapon', 'enemy'];
    // Which of the four typed fields a quoted proper name ("alley pond park") can land in -
    // matches resolve_named_styles' fields dict in server.py.
    const NAME_FIELD_ORDER = ['wall', 'player', 'weapon', 'enemy'];

    // What the player typed to make this dungeon, and what the server turned it into - the
    // tooltip a row's thumbnail carries, the one its Prompts button repeats, and the whole of
    // what a tile can show, having no room for an info line of its own.
    function historyPromptLines(entry) {
      const lines = [];
      if (entry.wall_style) lines.push('Dungeon: ' + entry.wall_style);
      if (entry.player_style) lines.push('Player: ' + entry.player_style);
      if (entry.weapon_style) lines.push('Weapon: ' + entry.weapon_style);
      if (entry.enemy_style) lines.push('Enemy: ' + entry.enemy_style);
      // When the typed words were abstract ("internet", "memes"), the server's set designer
      // resolved them into the concrete materials and objects that actually got drawn. Show
      // those under the typed words, so a surprising-looking dungeon explains itself. Absent
      // on dungeons saved before this existed, and on themes that matched a built-in style.
      if (entry.theme_brief) {
        const designed = THEME_BRIEF_ORDER
          .filter(k => entry.theme_brief[k])
          .map(k => '  ' + k + ': ' + entry.theme_brief[k]);
        if (designed.length) lines.push('', 'Designed into:', ...designed);
      }
      // A quoted proper name resolves to a kind of thing (a park, a cat) - show what each
      // named field turned into, the same spirit as "Designed into:" above but keyed to which
      // field actually carried a name. Absent on dungeons saved before this existed and on
      // runs where nothing was quoted.
      if (entry.named_styles) {
        const named = NAME_FIELD_ORDER
          .filter(k => entry.named_styles[k] && entry.named_styles[k].name)
          .map(k => {
            const n = entry.named_styles[k];
            const kind = n.kind ? ' (' + n.kind + (n.known ? ', recognised' : '') + ')' : '';
            return '  ' + k + ': ' + n.name + kind;
          });
        if (named.length) lines.push('', 'Named:', ...named);
      }
      return lines;
    }

    // The row's info line, in pieces: wall style · date · size · quality tier · music · ending.
    // A tile has no line for these, so they go into its tooltip instead.
    function historyMetaBits(entry) {
      const bits = [];
      if (entry.wall_style) bits.push(entry.wall_style);
      if (entry.created_text) bits.push(entry.created_text);
      const size = historySizeText(entry.size);
      if (size) bits.push(size);
      // Which "Graphics Quality" tier the assets were baked at (high quality / optimized /
      // reduced). Absent on dungeons saved before this was recorded.
      if (entry.quality_text) bits.push(entry.quality_text);
      if (entry.has_music) bits.push('♪ music');
      // An ending cutscene saved beside the run (Options > Ending Video). The server reads the
      // file itself for this, so a clip a background render finished later shows up too.
      if (entry.has_ending_video) bits.push('🎬 ending');
      return bits;
    }

    function buildHistoryRow(entry) {
      const row = document.createElement('div');
      row.className = 'hist-row win95-box p-1.5 flex items-center gap-2';
      // So a row can be found and repainted in place by its run - the movie button's progress
      // ticks along without rebuilding the list (see repaintHistoryMovies).
      row.dataset.id = entry.id || '';
      // History can be opened over a still-running game (the quit box's "Load a Different
      // Dungeon"), so one of these rows may be the dungeon the player is standing in. Mark it
      // here; the CSS gives it the selected-row look and renderHistoryList scrolls to it.
      const isCurrentRun = !!(entry.id && entry.id === currentRunHistoryId);
      if (isCurrentRun) {
        row.classList.add('hist-row--current');
        row.setAttribute('aria-current', 'true');
      }

      const thumbFrame = document.createElement('div');
      thumbFrame.className = 'win95-inset w-12 h-12 shrink-0 bg-black flex items-center justify-center overflow-hidden';
      // Hover the thumbnail to see exactly what the player typed into the creation wizard
      // for this dungeon. Native title tooltip - same treatment as the buttons below.
      const promptBits = historyPromptLines(entry);
      if (promptBits.length) {
        thumbFrame.title = promptBits.join('\n');
        thumbFrame.classList.add('cursor-help');
      }
      if (entry.thumb) {
        const img = document.createElement('img');
        img.src = entry.thumb;
        img.alt = '';
        img.className = 'w-full h-full object-contain pixelated';
        thumbFrame.appendChild(img);
      } else {
        const glyph = document.createElement('span');
        glyph.className = 'text-lg select-none';
        glyph.textContent = '🏰';
        thumbFrame.appendChild(glyph);
      }
      row.appendChild(thumbFrame);

      const col = document.createElement('div');
      col.className = 'flex flex-col min-w-0 flex-1 gap-0.5';

      // The title shares its line with the "now playing" tag, so both sit in a flex line and
      // the title keeps min-w-0 - without it a long name shoves the tag off the row instead
      // of truncating itself.
      const titleLine = document.createElement('div');
      titleLine.className = 'flex items-center gap-1.5 min-w-0';
      const title = document.createElement('div');
      title.className = 'text-xs font-black text-slate-900 truncate min-w-0';
      title.textContent = historyTitleOf(entry);
      titleLine.appendChild(title);
      if (isCurrentRun) {
        const tag = document.createElement('span');
        tag.className = 'hist-now-playing text-[9px] font-black px-1.5 py-0.5 shrink-0';
        tag.textContent = 'NOW PLAYING';
        tag.title = 'This is the dungeon running behind this window';
        titleLine.appendChild(tag);
      }
      const frameVerTag = buildFrameVersionTag(entry);
      if (frameVerTag) titleLine.appendChild(frameVerTag);
      col.appendChild(titleLine);

      const cast = document.createElement('div');
      cast.className = 'text-[10px] font-bold text-blue-900 truncate';
      const castBits = [entry.hero, entry.boss].filter(Boolean);
      cast.textContent = castBits.length
        ? castBits.join('  vs  ')
        : [entry.player_style, entry.enemy_style].filter(Boolean).join('  vs  ');
      col.appendChild(cast);

      const meta = document.createElement('div');
      meta.className = 'hist-meta text-[10px] text-slate-600 font-bold truncate';
      meta.textContent = historyMetaBits(entry).join('  ·  ');
      col.appendChild(meta);

      row.appendChild(col);

      const btnStart = document.createElement('button');
      btnStart.type = 'button';
      btnStart.className = 'hist-start win95-btn px-3 py-1.5 text-xs text-black bg-yellow-100 hover:bg-yellow-200 font-bold shrink-0';
      btnStart.textContent = '▶ Start';
      btnStart.title = isCurrentRun
        ? 'You are in this dungeon now - Start reloads it from the beginning, on a freshly drawn maze'
        : 'Play this dungeon again - no generation, straight to the loading screen';
      btnStart.addEventListener('click', () => startHistoryDungeon(entry));
      row.appendChild(btnStart);

      // The other half of a row: take the four things the player typed to make this dungeon
      // back to the menu instead of replaying it as it was. Sits between Start and the trash can
      // so the row reads info -> the two ways to use this dungeon -> delete, keeping the
      // destructive button last. Pointless in SHOWCASE_MODE - there is no main menu to send them
      // to, and no CREATE to use them with.
      if (!SHOWCASE_MODE) {
        const btnPrompts = document.createElement('button');
        btnPrompts.type = 'button';
        btnPrompts.className = 'hist-prompts win95-btn px-2.5 py-1.5 text-xs text-black bg-blue-100 hover:bg-blue-200 font-bold shrink-0';
        btnPrompts.textContent = '📋 Prompts';
        // The same typed words the thumbnail's tooltip lists, under a line saying what the
        // button does with them - this button IS the typed words, so showing them is the label.
        btnPrompts.title = 'Put what was typed to make this dungeon back on the main menu,'
          + ' ready to change a word and CREATE again.'
          + (promptBits.length ? '\n\n' + promptBits.join('\n') : '');
        btnPrompts.addEventListener('click', () => useHistoryPrompts(entry));
        row.appendChild(btnPrompts);
      }

      // The run's ending movie: plays it once the run has been beaten, films it if the run never
      // got one. What it will do right now - and why it won't - is in its tooltip, drawn by
      // paintHistoryMovie. A fixed w-12, wide enough for the "42%" it shows while filming.
      const btnMovie = document.createElement('button');
      btnMovie.type = 'button';
      btnMovie.className = 'hist-movie win95-btn w-12 px-0 py-1.5 text-xs shrink-0 hover:bg-blue-200';
      btnMovie.addEventListener('click', () => historyMovieAction(entry, btnMovie));
      row.appendChild(btnMovie);

      // The star sits right beside the trash can because it is that button's lock: starring a
      // dungeon greys the can out, and the server refuses to delete it until it is unstarred.
      // Both are a fixed w-10 rather than padded to their glyph: ☆ is narrower than ⭐ and 🔒
      // than 🗑️, and a padded width would nudge Start and Prompts sideways on every starred row.
      const btnStar = document.createElement('button');
      btnStar.type = 'button';
      btnStar.className = 'hist-star win95-btn w-10 px-0 py-1.5 text-xs shrink-0 hover:bg-yellow-200';
      btnStar.addEventListener('click', () => toggleHistoryFavorite(entry, row));
      row.appendChild(btnStar);

      // No server to ask permission of, and nowhere to send the delete either - dropped
      // entirely in SHOWCASE_MODE rather than disabled, the same treatment as Prompts above.
      if (!SHOWCASE_MODE) {
        const btnTrash = document.createElement('button');
        btnTrash.type = 'button';
        btnTrash.className = 'hist-trash win95-btn w-10 px-0 py-1.5 text-xs shrink-0 hover:bg-red-200';
        btnTrash.addEventListener('click', () => askDeleteHistory(entry));
        row.appendChild(btnTrash);
      }

      paintHistoryFavorite(row, entry);
      paintHistoryMovie(row, entry);
      return row;
    }

    // ==========================================
    // THE TILE VIEW
    // ==========================================
    // The same saved runs, read as pictures instead of rows. A tile's picture is that run's
    // card: its hero standing in their default pose - the idle frame the game rests on between
    // swings - in a corridor built from that run's own ceiling, wall and floor textures, drawn
    // server-side by _session_card in server.py. So "which dungeon was that?" is answered by
    // looking at it rather than by reading a line about it.
    //
    // A tile is a .hist-row like any other row: same data-id, same .hist-start / .hist-star /
    // .hist-movie buttons. Everything that works on the list - paintHistoryFavorite,
    // paintHistoryMovie, the two-second repaint while an ending films, the scroll-to-the-run-
    // you-are-in on open - therefore works on the grid without knowing which view is up.
    //
    // What a tile does NOT carry is Use Prompts and the trash can: three buttons is what fits
    // over a picture this size, and both of those live one click away in the list view.
    const HISTORY_VIEW_KEY = 'comfycrawler.historyView';
    let historyView = prefs.get(HISTORY_VIEW_KEY) === 'tiles' ? 'tiles' : 'list';

    // Where a run's card picture lives: an endpoint on the live server, which draws it on the
    // first request and keeps it beside the bundle, or the plain file tools/export_showcase.py
    // copied next to that dungeon in the static export. Same split as endingClipSrc.
    function historyCardSrc(id) {
      return SHOWCASE_MODE
        ? `dungeons/${encodeURIComponent(id)}/card.png`
        : `${SERVER_URL}/api/history_card?id=${encodeURIComponent(id)}`;
    }

    // A tile has one line for the name and one for the cast, and no room at all for the info
    // line a row carries - so everything else about the run goes into the tooltip on its
    // picture: the date, size, quality tier and music, then the words that were typed to make
    // it. Every string here came out of a language model, so it reaches the DOM through
    // .title / textContent and never as markup - same rule the rows follow.
    function historyTileTooltip(entry, castText) {
      const lines = [historyTitleOf(entry)];
      if (castText) lines.push(castText);
      const meta = historyMetaBits(entry);
      if (meta.length) lines.push(meta.join('  ·  '));
      if (Number(entry.frame_version) === 2) lines.push('Frame version 2 - foes have a strike frame');
      const prompts = historyPromptLines(entry);
      if (prompts.length) lines.push('', ...prompts);
      return lines.join('\n');
    }

    // ---- Fetching the pictures, one at a time ----------------------------------------------
    // server.py answers one request at a time (a plain TCPServer - see run_server), and drawing
    // a card for a run saved before tiles existed costs it most of a second: its 16MB bundle has
    // to be read back off disk. Six tiles asking at once therefore fill every connection the
    // browser will open to this host, and the next thing the page needs - a star, a delete, the
    // ending-job poll - is refused outright rather than queued ("Failed to fetch"). Measured:
    // that is exactly what a plain <img loading="lazy"> grid did.
    //
    // So the grid asks for its pictures itself: a tile's card is requested when the tile is
    // scrolled into view, and only ever one request is in flight. The blurred thumbnail under
    // it is what the player sees meanwhile, so a queue of thirty is not a grid of holes.
    const historyCardQueue = [];
    let historyCardInFlight = false;
    // Reads against the viewport rather than the list's own scroll box: the box is a different
    // element in the History window and in the showcase gallery, and the viewport contains both.
    // The margin starts the row below the fold fetching before it is scrolled to.
    const historyCardWatcher = ('IntersectionObserver' in window)
      ? new IntersectionObserver((entries, obs) => {
          entries.forEach(e => {
            if (!e.isIntersecting) return;
            obs.unobserve(e.target);
            historyCardQueue.push(e.target);
            pumpHistoryCards();
          });
        }, { rootMargin: '300px' })
      : null;

    function pumpHistoryCards() {
      if (historyCardInFlight) return;
      while (historyCardQueue.length) {
        const img = historyCardQueue.shift();
        // The list was rebuilt (a view switch, a delete, a refresh) while this waited its turn -
        // its tile is gone, and so is any reason to fetch its picture.
        if (!img.isConnected || !img.dataset.cardSrc) continue;
        historyCardInFlight = true;
        const done = () => {
          historyCardInFlight = false;
          pumpHistoryCards();
        };
        img.addEventListener('load', done, { once: true });
        img.addEventListener('error', done, { once: true });
        img.src = img.dataset.cardSrc;
        return;
      }
    }

    // Every image currently being watched. A detached one never fires the observer again - the
    // list was rebuilt out from under it - and the observer holds it alive, so each new tile
    // sweeps the dead ones out on its way in. That keeps a window opened and closed twenty
    // times from accumulating twenty lists' worth of images.
    const historyCardWatched = [];

    function queueHistoryCard(img, src) {
      img.dataset.cardSrc = src;
      // No IntersectionObserver (nothing this page runs on lacks it, but the grid should not
      // simply be blank if one turns up): fall back to asking for every card, still one at a
      // time through the same queue.
      if (!historyCardWatcher) {
        historyCardQueue.push(img);
        pumpHistoryCards();
        return;
      }
      for (let i = historyCardWatched.length - 1; i >= 0; i--) {
        if (historyCardWatched[i].isConnected) continue;
        historyCardWatcher.unobserve(historyCardWatched[i]);
        historyCardWatched.splice(i, 1);
      }
      historyCardWatched.push(img);
      historyCardWatcher.observe(img);
    }

    function buildHistoryTile(entry) {
      const tile = document.createElement('div');
      tile.className = 'hist-row hist-tile win95-box';
      tile.dataset.id = entry.id || '';
      const isCurrentRun = !!(entry.id && entry.id === currentRunHistoryId);
      if (isCurrentRun) {
        tile.classList.add('hist-row--current');
        tile.setAttribute('aria-current', 'true');
      }

      const castBits = [entry.hero, entry.boss].filter(Boolean);
      const castText = castBits.length
        ? castBits.join('  vs  ')
        : [entry.player_style, entry.enemy_style].filter(Boolean).join('  vs  ');

      const art = document.createElement('div');
      art.className = 'hist-tile__art';
      art.title = historyTileTooltip(entry, castText);

      // The listing's own 96px thumbnail goes down first, blown up and blurred. The card is a
      // separate request per tile - and on a run saved before tiles existed the server has to
      // draw it before it can answer - so without this the grid would be black rectangles for
      // as long as that takes. It also stays as the fallback: a run whose card cannot be drawn
      // at all keeps the blur rather than a hole.
      if (entry.thumb) {
        const under = document.createElement('img');
        under.src = entry.thumb;
        under.alt = '';
        under.className = 'hist-tile__under';
        art.appendChild(under);
      } else {
        const glyph = document.createElement('span');
        glyph.className = 'text-3xl select-none opacity-40';
        glyph.textContent = '🏰';
        art.appendChild(glyph);
      }

      if (entry.id) {
        const card = document.createElement('img');
        // No .pixelated class: the page already applies image-rendering: pixelated to every
        // img, and this one is no exception - a tile should look like the game does.
        card.className = 'hist-tile__card';
        card.alt = '';
        card.decoding = 'async';
        card.addEventListener('load', () => card.classList.add('is-loaded'));
        // No card for this run (an older static export, or a bundle with nothing drawable in
        // it): drop the empty image and leave the blurred thumbnail showing.
        card.addEventListener('error', () => card.remove());
        art.appendChild(card);
        // Not card.src = ... : see queueHistoryCard. The picture is fetched when the tile is
        // actually scrolled to, and only ever one at a time.
        queueHistoryCard(card, historyCardSrc(entry.id));
      }

      // What the run IS, readable without hovering: which one is running behind this window,
      // and whether it is starred. The actions below only appear on hover, and these two are
      // not actions.
      const badges = document.createElement('div');
      badges.className = 'hist-tile__badges';
      const tags = document.createElement('div');
      tags.className = 'flex items-center gap-1 min-w-0';
      if (isCurrentRun) {
        const tag = document.createElement('span');
        tag.className = 'hist-now-playing text-[9px] font-black px-1.5 py-0.5 shrink-0';
        tag.textContent = 'NOW PLAYING';
        tags.appendChild(tag);
      }
      const frameVerTag = buildFrameVersionTag(entry);
      if (frameVerTag) tags.appendChild(frameVerTag);
      badges.appendChild(tags);
      // Painted by paintHistoryFavorite along with the star button below, so starring a tile
      // lights its corner in the same click.
      const fav = document.createElement('span');
      fav.className = 'hist-tile__fav shrink-0';
      fav.textContent = '⭐';
      fav.hidden = true;
      badges.appendChild(fav);
      art.appendChild(badges);

      // The three actions, over the bottom of the picture. Built here rather than shared with
      // buildHistoryRow because only the classes and the handlers are common - a row's buttons
      // are labelled ("▶ Start") and sized to sit in a line of text, a tile's are glyphs sized
      // to sit on an image - but they carry the same .hist-* classes, so the paint functions
      // and the filming repaint drive either one.
      const acts = document.createElement('div');
      acts.className = 'hist-tile__acts';

      const btnStart = document.createElement('button');
      btnStart.type = 'button';
      btnStart.className = 'hist-start win95-btn text-black bg-yellow-100 hover:bg-yellow-200';
      btnStart.textContent = '▶';
      // Deliberately an empty title, not a missing one - see the same note on the star in
      // paintHistoryFavorite. A tile's actions already only appear on hover; a tooltip over
      // them is one fade-in too many, and with no title attribute at all the browser would
      // show the picture's own tooltip here instead of nothing.
      btnStart.title = '';
      btnStart.setAttribute('aria-label', isCurrentRun
        ? 'Play ' + historyTitleOf(entry) + ' again from the beginning - you are in it now'
        : 'Play ' + historyTitleOf(entry));
      btnStart.addEventListener('click', () => startHistoryDungeon(entry));
      acts.appendChild(btnStart);

      const btnStar = document.createElement('button');
      btnStar.type = 'button';
      btnStar.className = 'hist-star win95-btn text-black hover:bg-yellow-200';
      btnStar.addEventListener('click', () => toggleHistoryFavorite(entry, tile));
      acts.appendChild(btnStar);

      const btnMovie = document.createElement('button');
      btnMovie.type = 'button';
      btnMovie.className = 'hist-movie win95-btn text-black hover:bg-blue-200';
      btnMovie.addEventListener('click', () => historyMovieAction(entry, btnMovie));
      acts.appendChild(btnMovie);

      art.appendChild(acts);
      tile.appendChild(art);

      const cap = document.createElement('div');
      cap.className = 'hist-tile__cap';
      const title = document.createElement('div');
      title.className = 'text-[10px] font-black text-slate-900 truncate';
      title.textContent = historyTitleOf(entry);
      cap.appendChild(title);
      const cast = document.createElement('div');
      cast.className = 'text-[9px] font-bold text-blue-900 truncate';
      cast.textContent = castText;
      cap.appendChild(cast);
      tile.appendChild(cap);

      paintHistoryFavorite(tile, entry);
      paintHistoryMovie(tile, entry);
      return tile;
    }

    // One run, drawn the way the current view asks for. Both list renderers go through here.
    function buildHistoryEntryEl(entry) {
      return historyView === 'tiles' ? buildHistoryTile(entry) : buildHistoryRow(entry);
    }

    // Rows stack; tiles grid. The two containers keep their own inset frame, padding and
    // scroll height either way - only the layout of their children changes.
    function applyHistoryView() {
      const tiles = historyView === 'tiles';
      [historyList, showcaseList].forEach(el => {
        if (!el) return;
        el.classList.toggle('flex', !tiles);
        el.classList.toggle('flex-col', !tiles);
        el.classList.toggle('gap-1.5', !tiles);
        el.classList.toggle('hist-grid', tiles);
      });
      // Both pairs of buttons show the same setting - the History window's and the showcase
      // gallery's - so whichever one was clicked, both agree afterwards.
      [[btnHistoryViewList, btnShowcaseViewList], [btnHistoryViewTiles, btnShowcaseViewTiles]]
        .forEach(([a, b], i) => {
          const on = (i === 1) === tiles;
          [a, b].forEach(btn => {
            if (!btn) return;
            btn.classList.toggle('is-selected', on);
            btn.setAttribute('aria-pressed', on ? 'true' : 'false');
          });
        });
    }

    function setHistoryView(view) {
      const next = view === 'tiles' ? 'tiles' : 'list';
      if (next === historyView) return;
      historyView = next;
      prefs.set(HISTORY_VIEW_KEY, historyView);
      applyHistoryView();
      // Rebuild whichever list is on screen. The entries are already in memory, so this is a
      // redraw and not a refetch - nothing goes back to the server for it.
      renderHistoryList();
      if (SHOWCASE_MODE) renderShowcaseList();
    }

    if (btnHistoryViewList) btnHistoryViewList.addEventListener('click', () => setHistoryView('list'));
    if (btnHistoryViewTiles) btnHistoryViewTiles.addEventListener('click', () => setHistoryView('tiles'));
    if (btnShowcaseViewList) btnShowcaseViewList.addEventListener('click', () => setHistoryView('list'));
    if (btnShowcaseViewTiles) btnShowcaseViewTiles.addEventListener('click', () => setHistoryView('tiles'));
    applyHistoryView();

    // Which frame version a saved run was generated as. 1 is every run made without Last Attack
    // Frame - including all of those saved before the option existed, which the server reports
    // as 1 - and 2 is a run whose foes were drawn with a strike frame. Version 1 is the common
    // case (most of history), so it gets no badge; only the version 2 runs - the ones that carry
    // something extra - are worth flagging, and null here means the caller skips the tag
    // entirely. Sits in the title line rather than the info line below it, because that line
    // turns into a marquee when it runs long and would carry the version off the edge with it.
    function buildFrameVersionTag(entry) {
      const version = Number(entry.frame_version) === 2 ? 2 : 1;
      if (version === 1) return null;
      const tag = document.createElement('span');
      tag.className = 'hist-frame-ver hist-frame-ver--v2 text-[9px] font-black px-1.5 py-0.5 shrink-0';
      tag.textContent = 'FRAME V2';
      // Said in terms of what the run HAS, not how it plays - that is the Options setting's call
      // (Quick plays either version without a wind-up), and the note at the bottom covers it.
      let tip = 'Frame version 2 - made with Last Attack Frame on: its foes also have a strike'
        + ' frame, shown the moment their attack lands.';
      // The quality gate can drop a pose frame it could not get framed, so say which foes it
      // took - the others play that moment on their attack frame. Only when the list was
      // recorded at all.
      if (Array.isArray(entry.strike_frames)) {
        const lost = ENEMY_VARIANT_KEYS.filter(k => !entry.strike_frames.includes(k));
        if (lost.length === ENEMY_VARIANT_KEYS.length) {
          tip += '\nNo foe came out of generation with one, so it plays like version 1.';
        } else if (lost.length) {
          tip += '\nNo strike frame on the ' + lost.join(' or ') + ' - generation dropped it.';
        }
      }
      // The Options setting also decides whether the frame is SHOWN - only 'on' shows it - so a
      // version 2 run replayed on any other mode looks like version 1. Worth saying before that
      // reads as a broken run.
      if (lastAttackFrameMode !== 'on') {
        const modeName = { off: 'Off', quick: 'Quick', flip: 'Flip', mixed: 'Mixed' }[lastAttackFrameMode] || 'Off';
        tip += '\nLast Attack Frame is set to ' + modeName
          + ' in Options, so the strike frame is not shown right now.';
      }
      tag.title = tip;
      return tag;
    }

    // The star and the trash can on one row, drawn from entry.favorite. Kept apart from
    // buildHistoryRow so a toggle repaints the row it happened on in place: rebuilding the list
    // would drop the keyboard cursor off the star it is sitting on and restart every marquee.
    function paintHistoryFavorite(row, entry) {
      const fav = !!entry.favorite;
      const star = row.querySelector('.hist-star');
      if (star) {
        // Held down while starred - the same pressed-in bevel the selected difficulty keeps.
        star.classList.toggle('is-selected', fav);
        star.textContent = fav ? '⭐' : '☆';
        star.setAttribute('aria-pressed', fav ? 'true' : 'false');
        const says = fav
          ? 'Favorite - locked against deleting. Click to unstar it.'
          : 'Favorite this dungeon - it cannot be deleted while it is starred';
        star.setAttribute('aria-label', says);
        // No hover tooltip on a tile's star: the strip only appears once the tile is hovered,
        // so a tooltip on top of it is a second thing fading in over the picture just as the
        // player is trying to look at it. The empty title is deliberate rather than omitted -
        // with no title at all the browser walks up and shows the PICTURE's tooltip instead.
        // The label above still carries the same words to a screen reader.
        star.title = star.closest('.hist-tile') ? '' : says;
      }
      // A tile's corner star: the same flag, shown without hovering, since the star BUTTON
      // is hidden until the tile is hovered or arrowed onto. Rows have no such element.
      const favBadge = row.querySelector('.hist-tile__fav');
      if (favBadge) {
        favBadge.hidden = !fav;
        favBadge.title = 'Favorite - locked against deleting';
      }
      const trash = row.querySelector('.hist-trash');
      if (trash) {
        trash.disabled = fav;
        trash.textContent = fav ? '🔒' : '🗑️';
        trash.title = fav
          ? 'Locked - this dungeon is a favorite. Unstar it to delete it.'
          : 'Delete this saved dungeon and its assets';
      }
    }

    // Anything that can erase a run - this list's trash can, the quit menu's Erase Current
    // Run - asks here first. The last listing is the page's copy of the flag; the server
    // checks meta.json again on every delete, so a stale copy can only ever refuse, not erase.
    function isFavoriteHistoryId(id) {
      if (!id || !Array.isArray(historyEntries)) return false;
      const entry = historyEntries.find(e => e.id === id);
      return !!(entry && entry.favorite);
    }

    async function toggleHistoryFavorite(entry, row) {
      if (!entry) return;
      if (SHOWCASE_MODE) {
        entry.favorite = showcaseState.setFavorite(entry.id, !entry.favorite);
        paintHistoryFavorite(row, entry);
        renderHistoryFootNote();
        return;
      }
      try {
        const res = await fetch(`${SERVER_URL}/api/history_favorite`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: entry.id, favorite: !entry.favorite })
        });
        const data = await res.json().catch(() => ({}));
        if (!data.success) throw new Error(data.error || 'The server refused the change.');
        entry.favorite = !!data.favorite;
      } catch (err) {
        console.error('History favorite error:', err);
        alert('Could not change that favorite.\n\n' + err.message);
        // Most likely the run was deleted behind this page - re-list rather than guess.
        const scrollBack = historyList ? historyList.scrollTop : 0;
        await refreshHistory();
        if (historyList) historyList.scrollTop = scrollBack;
        return;
      }
      paintHistoryFavorite(row, entry);
      renderHistoryFootNote();
    }

    // The Victory box's own star, so a run worth keeping can be locked in the moment it's won
    // instead of the player having to remember its wall/prompt combo and go find it in History
    // afterward. Mirrors currentRunFavorite rather than an entry.favorite lookup - see that
    // variable's declaration for why - and pushes the same change into historyEntries when a
    // matching row exists there, so the History window agrees without a refetch.
    function paintVictoryFavorite() {
      if (!btnVictoryFavorite) return;
      btnVictoryFavorite.disabled = !currentRunHistoryId;
      btnVictoryFavorite.textContent = currentRunFavorite ? '⭐ Favorited' : '☆ Favorite this run';
      btnVictoryFavorite.classList.toggle('is-selected', currentRunFavorite);
      btnVictoryFavorite.title = !currentRunHistoryId
        ? 'This run has no saved History entry to favorite.'
        : currentRunFavorite
          ? 'Favorite - locked against deleting in History. Click to unstar it.'
          : 'Favorite this dungeon - it cannot be deleted from History while it is starred';
    }

    async function toggleVictoryFavorite() {
      if (!currentRunHistoryId) return;
      const wasFavorite = currentRunFavorite;
      if (SHOWCASE_MODE) {
        currentRunFavorite = showcaseState.setFavorite(currentRunHistoryId, !wasFavorite);
        if (Array.isArray(historyEntries)) {
          const entry = historyEntries.find(e => e.id === currentRunHistoryId);
          if (entry) entry.favorite = currentRunFavorite;
        }
        paintVictoryFavorite();
        return;
      }
      try {
        const res = await fetch(`${SERVER_URL}/api/history_favorite`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: currentRunHistoryId, favorite: !wasFavorite })
        });
        const data = await res.json().catch(() => ({}));
        if (!data.success) throw new Error(data.error || 'The server refused the change.');
        currentRunFavorite = !!data.favorite;
      } catch (err) {
        console.error('Victory favorite error:', err);
        alert('Could not change that favorite.\n\n' + err.message);
        return;
      }
      // Keep the History window's own copy in sync so opening it later needs no refetch -
      // same reasoning as currentRunFavorite's own comment.
      if (Array.isArray(historyEntries)) {
        const entry = historyEntries.find(e => e.id === currentRunHistoryId);
        if (entry) entry.favorite = currentRunFavorite;
      }
      paintVictoryFavorite();
    }
    if (btnVictoryFavorite) btnVictoryFavorite.addEventListener('click', toggleVictoryFavorite);

    // ==========================================
    // ENDING MOVIES IN HISTORY
    // ==========================================
    // Every row carries a movie button for its run's ending - the same clip Options > Ending Video
    // plays in the dungeon, kept as dungeon_sessions/<id>/ending.mp4. A run that has been beaten
    // plays it back here (before that it is a spoiler, and the button stays locked); a run that
    // never got one films one on the spot. While that H3 render runs, nothing else that needs
    // ComfyUI can be started from this page: CREATE, Fill-in and the other rows' movie buttons grey
    // out - the server refuses them too - and come back the moment it is done.
    const ENDING_JOB_POLL_MS = 2000;
    let endingJobWatchTimer = null;
    let endingJobWatchSeq = 0;

    function endingJobActive(job) {
      const j = job || endingJob;
      return j.state === 'queued' || j.state === 'rendering';
    }

    // What a row's movie button does right now: {kind: filming | watch | locked | film, label,
    // title, disabled}. The title is the player-facing status, so every branch says why.
    function historyMovieState(entry) {
      if (endingJobActive() && endingJob.session === entry.id) {
        // Left clickable - only greyed a little by CSS - because clicking it again is how filming
        // is stopped: it asks first, in askStopEndingFilm.
        const pct = Math.max(0, Math.min(99, endingJob.percent || 0));
        const who = endingJob.manual
          ? "Filming this dungeon's ending movie"
          : "Filming this dungeon's ending movie in the background, for the run being played";
        return {
          kind: 'filming', disabled: false,
          label: endingJob.state === 'rendering' ? pct + '%' : '⏳',
          title: who + (endingJob.state === 'rendering'
            ? ' - ' + pct + '% done.' : ' - waiting for ComfyUI to start on it.')
            + ' Click to stop filming.',
        };
      }
      if (entry.has_ending_video) {
        return entry.beaten
          ? { kind: 'watch', disabled: false, label: '🎬',
              title: "Watch this dungeon's ending movie." }
          : { kind: 'locked', disabled: true, label: '🎬',
              title: 'This dungeon has an ending movie - beat its boss to unlock it.' };
      }
      // No server to film one on, so the button is just inert instead of offering an action that
      // would 404. Every dungeon tools/export_showcase.py has copied so far has a clip already,
      // but a future export is not guaranteed to.
      if (SHOWCASE_MODE) {
        return { kind: 'none', disabled: true, label: '🎬',
                 title: 'This dungeon has no ending movie.' };
      }
      // Another render this button must not replace: one the player asked for, or the background
      // render of the run they are standing in. (A background render for a run they have left
      // just gives way, the same as it does for CREATE.)
      if (endingJobActive() && (endingJob.manual || endingJob.session === currentRunHistoryId)) {
        return { kind: 'film', disabled: true, label: '🎥',
                 title: 'Another ending movie is being filmed - wait for it to finish.' };
      }
      const failed = endingJob.session === entry.id && endingJob.state === 'failed';
      const head = failed
        ? "Filming this dungeon's ending movie failed"
          + (endingJob.error ? ' (' + endingJob.error + ')' : '') + '. Click to try again'
        : 'No ending movie yet - click to film one';
      return {
        kind: 'film', disabled: false, label: '🎥',
        title: head + '. CREATE and Fill-in wait until it is done.'
          + (entry.beaten ? '' : ' Beat this dungeon to watch it.'),
      };
    }

    function paintHistoryMovie(row, entry) {
      const btn = row.querySelector('.hist-movie');
      if (!btn) return;
      const st = historyMovieState(entry);
      const hadFocus = document.activeElement === btn;
      btn.textContent = st.label;
      btn.title = st.title;
      btn.setAttribute('aria-label', st.title);
      btn.dataset.kind = st.kind;
      btn.disabled = st.disabled;
      // Greying out the button under the keyboard cursor (it just started filming) would drop
      // focus on the page, and the arrow keys would have nothing to move from - hand it to the
      // same row's Start instead.
      if (hadFocus && st.disabled) {
        const start = row.querySelector('.hist-start');
        if (start) start.focus({ preventScroll: true });
      }
    }

    // The rows are repainted in place rather than rebuilt: rebuilding every two seconds would
    // restart every marquee and throw the keyboard cursor off whatever it is sitting on.
    function repaintHistoryMovies() {
      if (!historyList || !Array.isArray(historyEntries)) return;
      historyList.querySelectorAll('.hist-row').forEach(row => {
        const entry = historyEntries.find(e => e.id === row.dataset.id);
        if (entry) paintHistoryMovie(row, entry);
      });
    }

    // Everything a render outside a run greys out, repainted from endingJob.
    function paintEndingJobLocks() {
      setCreateSettling(createSettlingNow);
      if (btnFillIn && !fillInFlight) {
        btnFillIn.disabled = endingManualFilming();
        syncFillInLabel();
      }
      repaintHistoryMovies();
      paintStopEndingFilm();
    }

    // ---- Stopping a render: the filming button, clicked again -------------------------------
    // Stopping throws minutes of work away, so it asks first in its own box stacked over History,
    // opening on Keep Filming - never on the button that stops it.
    const modalEndingStopConfirm = document.getElementById('modalEndingStopConfirm');
    const endingStopName = document.getElementById('endingStopName');
    const endingStopText = document.getElementById('endingStopText');
    const btnEndingStopClose = document.getElementById('btnEndingStopClose');
    const btnEndingStopKeep = document.getElementById('btnEndingStopKeep');
    const btnEndingStopGo = document.getElementById('btnEndingStopGo');
    let endingStopPending = null;   // {id, btn} while the box is asking about a run

    function askStopEndingFilm(entry, btn) {
      if (!modalEndingStopConfirm) return;
      endingStopPending = { id: entry.id, btn: btn || null };
      if (endingStopName) {
        endingStopName.textContent = historyTitleOf(entry)
          + (entry.created_text ? '  —  ' + entry.created_text : '');
      }
      // Shown before it is painted: paintStopEndingFilm only ever touches a box that is up.
      modalEndingStopConfirm.classList.remove('hidden');
      paintStopEndingFilm();
      focusFirstIn(modalEndingStopConfirm, btnEndingStopKeep);
    }

    // Keeps the box's progress line current while it is up, and takes the box down on its own if
    // the render it is asking about stops existing - it finished, or failed - since there is then
    // nothing left to stop.
    function paintStopEndingFilm() {
      if (!endingStopPending || !modalEndingStopConfirm
          || modalEndingStopConfirm.classList.contains('hidden')) return;
      if (!(endingJobActive() && endingJob.session === endingStopPending.id)) {
        closeStopEndingFilm();
        return;
      }
      if (!endingStopText) return;
      const pct = Math.max(0, Math.min(99, endingJob.percent || 0));
      endingStopText.textContent =
        (endingJob.state === 'rendering' ? 'It is ' + pct + '% done. ' : 'It has not started yet. ')
        + 'Stopping throws that away - filming it again starts over from the beginning.'
        + (endingJob.manual ? ''
          : ' It is filming for the run you are playing, which will then end at the stairs instead.');
    }

    function closeStopEndingFilm() {
      const wasOpen = modalEndingStopConfirm && !modalEndingStopConfirm.classList.contains('hidden');
      const back = endingStopPending && endingStopPending.btn;
      endingStopPending = null;
      if (modalEndingStopConfirm) modalEndingStopConfirm.classList.add('hidden');
      if (!wasOpen) return;
      // Back onto the movie button it came from, like the delete box hands back to the list.
      if (back && back.isConnected && !back.disabled) back.focus({ preventScroll: true });
      else if (modalHistory && !modalHistory.classList.contains('hidden')) focusFirstIn(modalHistory, btnHistoryOk);
    }

    async function confirmStopEndingFilm() {
      const pending = endingStopPending;
      if (!pending) { closeStopEndingFilm(); return; }
      // Greyed-out buttons come back as soon as the server says it has stopped, rather than on the
      // next two-second poll - so ask it, then look straight away.
      try {
        const res = await fetch(`${SERVER_URL}/api/ending_video_cancel`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: pending.id })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) throw new Error(data.error || 'The server refused.');
      } catch (err) {
        console.error('Stop filming error:', err);
        alert('Could not stop filming that ending movie.\n\n' + err.message);
      }
      closeStopEndingFilm();
      watchEndingJob();
    }

    if (btnEndingStopClose) btnEndingStopClose.addEventListener('click', closeStopEndingFilm);
    if (btnEndingStopKeep) btnEndingStopKeep.addEventListener('click', closeStopEndingFilm);
    if (btnEndingStopGo) btnEndingStopGo.addEventListener('click', confirmStopEndingFilm);
    if (modalEndingStopConfirm) {
      modalEndingStopConfirm.addEventListener('click', (e) => {
        if (e.target === modalEndingStopConfirm) closeStopEndingFilm();
      });
    }

    // Follows the one render outside a run until it is done, then puts everything back. Started
    // at page load (a reload in the middle of one), when History opens, and by a row's button.
    async function watchEndingJob() {
      if (SHOWCASE_MODE) return;   // no server to ask, and nothing in an export can be filming
      if (endingJobWatchTimer) { clearTimeout(endingJobWatchTimer); endingJobWatchTimer = null; }
      const seq = ++endingJobWatchSeq;
      let next = null;
      try {
        const res = await fetch(`${SERVER_URL}/api/ending_video_job`);
        next = await res.json();
      } catch (err) {
        next = null;   // server away for a moment
      }
      if (seq !== endingJobWatchSeq) return;   // a newer check is already on its way
      const before = endingJob;
      if (next) endingJob = next;
      if (endingJobActive(before) && !endingJobActive() && endingJob.session === before.session) {
        endingJobFinished(endingJob);
      }
      paintEndingJobLocks();
      if (next ? endingJobActive() : endingJobActive(before)) {
        endingJobWatchTimer = setTimeout(watchEndingJob, ENDING_JOB_POLL_MS);
      }
    }

    function endingJobFinished(job) {
      if (job.state !== 'ready') return;   // failed or cancelled: the row's tooltip says which
      if (Array.isArray(historyEntries)) {
        const entry = historyEntries.find(e => e.id === job.session);
        if (entry) entry.has_ending_video = true;
      }
      // History is open over the very run it was filmed for, with Ending Video on: that run's
      // cutscene should pick it up now rather than only on the next visit.
      if (endingVideoOn && job.session === endingRunId && !endingClipUrl && !endingPollTimer) {
        pollEndingStatus(endingRunId, false);
      }
    }

    async function historyMovieAction(entry, btn) {
      const st = historyMovieState(entry);
      if (st.disabled) return;
      if (st.kind === 'filming') { askStopEndingFilm(entry, btn); return; }
      if (st.kind === 'watch') { openEndingPlayer(entry, btn); return; }
      if (st.kind !== 'film') return;
      // Everything greys out on the click rather than a poll later - there is a round trip to the
      // server before the job exists, and a second click must not land in it.
      endingJob = { state: 'queued', session: entry.id, percent: 0, error: null, manual: true };
      paintEndingJobLocks();
      let reply = null;
      try {
        const res = await fetch(`${SERVER_URL}/api/ending_video_start`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: entry.id, manual: true })
        });
        reply = await res.json().catch(() => null);
      } catch (err) {
        reply = null;
      }
      if (!reply) {
        alert('Could not reach the server to film that ending movie.');
      } else if (reply.state === 'busy') {
        alert('ComfyUI is still busy with something else - try again in a moment.');
      } else if (reply.state === 'missing') {
        alert('That saved dungeon is gone.');
      } else if (reply.state === 'failed') {
        alert('Could not start filming that ending movie.\n\n' + (reply.error || ''));
      } else if (reply.state === 'ready') {
        entry.has_ending_video = true;
      }
      // Whatever came back, the server's own job is the truth from here on.
      watchEndingJob();
      if (reply && reply.state === 'missing') refreshHistory();
    }

    // ---- The movie player, over the History window ------------------------------------------
    const modalEndingPlayer = document.getElementById('modalEndingPlayer');
    const endingPlayerVideo = document.getElementById('endingPlayerVideo');
    const endingPlayerTitle = document.getElementById('endingPlayerTitle');
    const endingPlayerNote = document.getElementById('endingPlayerNote');
    const btnEndingPlayerClose = document.getElementById('btnEndingPlayerClose');
    const btnEndingPlayerReplay = document.getElementById('btnEndingPlayerReplay');
    const btnEndingPlayerOk = document.getElementById('btnEndingPlayerOk');
    let endingPlayerUrl = null;      // blob: URL of the clip on show
    let endingPlayerReturn = null;   // the row button to hand the keyboard cursor back to
    let endingPlayerSeq = 0;         // bumped on every open and close, so a late download is dropped

    // Whatever music is up - the menu loop, or the dungeon behind a History opened mid-run - sits
    // well under the movie's own soundtrack while it plays, then comes back.
    function duckMusicForMovie(on) {
      const ctx = sfxContext();
      if (!ctx || !musicMaster) return;
      const g = musicMaster.gain;
      const now = ctx.currentTime;
      g.cancelScheduledValues(now);
      g.setValueAtTime(g.value, now);
      g.linearRampToValueAtTime(on ? 0.08 : 0.6, now + (on ? 0.4 : 0.9));
    }

    async function openEndingPlayer(entry, returnTo) {
      if (!modalEndingPlayer || !endingPlayerVideo) return;
      const seq = ++endingPlayerSeq;
      endingPlayerReturn = returnTo || null;
      if (endingPlayerTitle) endingPlayerTitle.textContent = '🎬 ' + historyTitleOf(entry);
      if (endingPlayerNote) endingPlayerNote.textContent = 'Loading the ending movie...';
      if (btnEndingPlayerReplay) btnEndingPlayerReplay.disabled = true;
      modalEndingPlayer.classList.remove('hidden');
      focusFirstIn(modalEndingPlayer, btnEndingPlayerOk);
      duckMusicForMovie(true);
      try {
        const res = await fetch(endingClipSrc(entry.id));
        if (!res.ok) throw new Error(res.status === 404 ? 'It is not on disk any more.' : 'HTTP ' + res.status);
        const blob = await res.blob();
        if (seq !== endingPlayerSeq) return;   // closed while it downloaded
        endingPlayerUrl = URL.createObjectURL(blob);
        endingPlayerVideo.src = endingPlayerUrl;
        endingPlayerVideo.volume = ENDING_VOLUME;
        endingPlayerVideo.muted = false;
        if (endingPlayerNote) {
          endingPlayerNote.textContent = [entry.hero, entry.boss].filter(Boolean).join('  vs  ');
        }
        if (btnEndingPlayerReplay) btnEndingPlayerReplay.disabled = false;
        const p = endingPlayerVideo.play();
        if (p && p.catch) p.catch(() => {});
      } catch (err) {
        if (seq !== endingPlayerSeq) return;
        if (endingPlayerNote) endingPlayerNote.textContent = 'Could not load the ending movie. ' + err.message;
      }
    }

    function closeEndingPlayer() {
      if (!modalEndingPlayer || modalEndingPlayer.classList.contains('hidden')) return;
      endingPlayerSeq++;
      if (endingPlayerVideo) {
        try { endingPlayerVideo.pause(); } catch (e) {}
        endingPlayerVideo.removeAttribute('src');
        endingPlayerVideo.load();
      }
      if (endingPlayerUrl) { URL.revokeObjectURL(endingPlayerUrl); endingPlayerUrl = null; }
      modalEndingPlayer.classList.add('hidden');
      duckMusicForMovie(false);
      const back = endingPlayerReturn;
      endingPlayerReturn = null;
      if (back && back.isConnected && !back.disabled) {
        back.focus({ preventScroll: true });
      } else if (modalHistory && !modalHistory.classList.contains('hidden')) {
        focusFirstIn(modalHistory, btnHistoryOk);
      }
    }

    function replayEndingPlayer() {
      if (!endingPlayerUrl || !endingPlayerVideo) return;
      duckMusicForMovie(true);   // the last play-through handed it back as its sound faded
      try { endingPlayerVideo.currentTime = 0; } catch (e) {}
      const p = endingPlayerVideo.play();
      if (p && p.catch) p.catch(() => {});
    }

    // Same fade as the cutscene, and the music the movie ducked comes back up underneath it, so
    // the movie ends on a crossfade here too rather than a hard stop into the quiet.
    if (endingPlayerVideo) {
      fadeEndingAudioOut(endingPlayerVideo, () => {
        if (modalEndingPlayer && !modalEndingPlayer.classList.contains('hidden')) duckMusicForMovie(false);
      });
      createClipScaler(endingPlayerVideo, document.getElementById('endingPlayerCanvas'));
    }
    if (btnEndingPlayerClose) btnEndingPlayerClose.addEventListener('click', closeEndingPlayer);
    if (btnEndingPlayerOk) btnEndingPlayerOk.addEventListener('click', closeEndingPlayer);
    if (btnEndingPlayerReplay) btnEndingPlayerReplay.addEventListener('click', replayEndingPlayer);
    // Clicking the darkened list behind it backs out, like every other box stacked on History.
    if (modalEndingPlayer) {
      modalEndingPlayer.addEventListener('click', (e) => {
        if (e.target === modalEndingPlayer) closeEndingPlayer();
      });
    }

    // "Similar only". Two prompts count as the same idea only when one is written inside the
    // other ("windows 95" / "windows 95 3d maze") or they're identical outright - NOT merely
    // sharing a word, which let a "corn maze" through as "similar" to a "windows 95 3d maze"
    // on nothing but both saying "maze".
    function historyFieldsSimilar(current, saved) {
      const a = (current || '').trim().toLowerCase().replace(/["“”]/g, '');
      const b = (saved || '').trim().toLowerCase().replace(/["“”]/g, '');
      if (!a || !b) return false;
      return a === b || a.includes(b) || b.includes(a);
    }

    // What "similar" is measured against. Mid-run, that's the dungeon actually being played -
    // not the mad-lib fields, which Start-from-History never touches (so they can be whatever
    // was last typed there, unrelated to the run you're now in) and which may simply hold a
    // different idea you're drafting for next time. Only at the menu, with no run behind the
    // window, do the fields themselves become the reference.
    function historySimilarReference() {
      const active = (Array.isArray(historyEntries) && currentRunHistoryId)
        ? historyEntries.find(e => e.id === currentRunHistoryId) : null;
      if (active) {
        return {
          wall: active.wall_style || '', player: active.player_style || '',
          weapon: active.weapon_style || '', enemy: active.enemy_style || ''
        };
      }
      return {
        wall: wallPromptInput ? wallPromptInput.value : '',
        player: playerPromptInput ? playerPromptInput.value : '',
        weapon: weaponPromptInput ? weaponPromptInput.value : '',
        enemy: enemyPromptInput ? enemyPromptInput.value : ''
      };
    }

    function historyReferenceIsBlank(ref) {
      return !ref.wall.trim() && !ref.player.trim() && !ref.weapon.trim() && !ref.enemy.trim();
    }

    // The dungeon's look (wall_style) is what a saved run actually reads as "the same" at a
    // glance - the thumbnail and title are both built from it - so it alone decides the match
    // whenever there is one to compare. Player/weapon/enemy only step in when no dungeon style
    // is set at all, rather than being OR'd in alongside it: that OR is what previously let a
    // matching hero alone wave through a completely different-looking dungeon.
    function historyEntryMatchesReference(entry, ref) {
      if (ref.wall.trim()) return historyFieldsSimilar(ref.wall, entry.wall_style);
      return historyFieldsSimilar(ref.player, entry.player_style)
          || historyFieldsSimilar(ref.weapon, entry.weapon_style)
          || historyFieldsSimilar(ref.enemy, entry.enemy_style);
    }

    // The checkbox greys itself out (and drops its own tick) whenever there is nothing to
    // compare against, rather than sitting there checked and silently doing nothing.
    function syncHistorySimilarOnly() {
      if (!historySimilarOnly) return;
      const blank = historyReferenceIsBlank(historySimilarReference());
      if (blank) historySimilarOnly.checked = false;
      historySimilarOnly.disabled = blank;
      if (historySimilarOnlyLabel) historySimilarOnlyLabel.classList.toggle('opacity-50', blank);
    }

    // The subset of historyEntries the list is actually showing right now - every saved run,
    // unless "Similar only" is both checked and has something to filter by.
    function visibleHistoryEntries() {
      if (!Array.isArray(historyEntries)) return historyEntries;
      syncHistorySimilarOnly();
      if (!historySimilarOnly || !historySimilarOnly.checked) return historyEntries;
      const ref = historySimilarReference();
      return historyEntries.filter(entry => historyEntryMatchesReference(entry, ref));
    }

    function renderHistoryList() {
      if (!historyList) return;
      if (historyEntries === null) {
        setHistoryMessage('Could not reach the server. Make sure server.py is running.');
        if (historyFootNote) historyFootNote.textContent = '';
        return;
      }
      if (!historyEntries.length) {
        setHistoryMessage('No dungeons saved yet. Every dungeon you CREATE is kept here, so you can play it again without generating it again.');
        if (historyFootNote) historyFootNote.textContent = '';
        return;
      }
      const visible = visibleHistoryEntries();
      if (!visible.length) {
        setHistoryMessage('No saved runs look like the prompt on the main menu. Uncheck "Similar only" to see them all.');
        renderHistoryFootNote();
        return;
      }
      historyList.innerHTML = '';
      visible.forEach(entry => historyList.appendChild(buildHistoryEntryEl(entry)));
      // Opened from inside a run, the row for that run is the one the player came to find -
      // and it can be anywhere in a list of thirty - so bring the list to it and flash it once.
      const currentRow = historyRevealCurrent
        ? historyList.querySelector('.hist-row--current') : null;
      historyRevealCurrent = false;
      if (currentRow) {
        // Centred by hand rather than with scrollIntoView: this list is a scroll container
        // inside a modal, and scrollIntoView walks every scrollable ancestor, dragging the page
        // behind the window along with it. Measured off the rects, so it does not matter which
        // positioned ancestor the row's offsetParent happens to be.
        const rowTop = currentRow.getBoundingClientRect().top
                     - historyList.getBoundingClientRect().top + historyList.scrollTop;
        historyList.scrollTop =
          Math.max(0, rowTop - (historyList.clientHeight - currentRow.offsetHeight) / 2);
        // One-shot pulse, dropped again when it ends so re-opening History flashes it anew.
        currentRow.classList.add('hist-row--found');
        currentRow.addEventListener('animationend',
          () => currentRow.classList.remove('hist-row--found'), { once: true });
      }
      // openHistory parked the keyboard cursor on OK while this was still loading; now that
      // there are rows, move it to a Start - the button the window is actually for - taking the
      // live run's row over the first one whenever there is one to take, so the keyboard lands
      // where the scroll just did. Only from OK, so a cursor the player has already moved (or a
      // delete they are in the middle of confirming) is never yanked out from under them.
      if (document.activeElement === btnHistoryOk) {
        const firstStart = (currentRow && currentRow.querySelector('.hist-start'))
          || historyList.querySelector('.hist-start');
        if (firstStart) firstStart.focus({ preventScroll: true });
      }
      // The rows are in the DOM now but layout has not necessarily flushed - wait one
      // frame, then turn any info line that overran its column into a scrolling marquee.
      requestAnimationFrame(() => {
        historyList.querySelectorAll('.hist-meta').forEach(marqueeIfOverflowing);
      });
      renderHistoryFootNote();
    }

    // "12 dungeons · 3 favorites · 410.2 MB on disk". Its own function so a star toggle can
    // recount without rebuilding the rows above it.
    function renderHistoryFootNote() {
      if (!historyFootNote || !Array.isArray(historyEntries)) return;
      const total = historyEntries.reduce((sum, e) => sum + (e.size || 0), 0);
      const size = historySizeText(total);
      const favs = historyEntries.filter(e => e.favorite).length;
      // Disk usage and favorites still describe the whole library even while filtered - only
      // the headline count narrows, so it reads "3 of 12" rather than a plain "3 dungeons"
      // that would make the filter look like the entire saved history.
      const visible = visibleHistoryEntries();
      const countText = visible.length === historyEntries.length
        ? historyEntries.length + (historyEntries.length === 1 ? ' dungeon' : ' dungeons')
        : visible.length + ' of ' + historyEntries.length + ' dungeons similar to this prompt';
      historyFootNote.textContent =
        countText
        + (favs ? '  ·  ' + favs + (favs === 1 ? ' favorite' : ' favorites') : '')
        + (size ? '  ·  ' + size + ' on disk' : '');
    }

    // The two folder buttons in the footer, and every model row in the About window. A browser
    // cannot open a local directory, so the server runs ShellExecute for us - and it takes a KEY
    // ('sessions' or 'assets'), never a path, so this can only ever reach the two folders
    // server.py names in OPENABLE_FOLDERS, or (with `file`) one of a model folder's own search
    // paths - see MODEL_FOLDER_NAMES / MODEL_FILES_BY_FOLDER there.
    //
    // 'sessions' is dungeon_sessions/, one folder per saved run - the same folder the trash can
    // deletes from. 'assets' is the ComfyUI output folder, where the raw renders land; nothing
    // reads those back once a bundle is saved, so that is also where an abandoned run's
    // leftovers sit. Neither button deletes anything: they just open the window.
    //
    // `file` names which file a "model:<folder>" row is for - a folder type can search more than
    // one directory (extra_model_paths.yaml, ComfyUI Desktop's shared-models base), and the file
    // can live in a different one than the first, so the server needs to know which file to open
    // the REAL directory for rather than always the primary one.
    async function openServerFolder(which, file) {
      try {
        const res = await fetch(`${SERVER_URL}/api/open_folder`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(file ? { which, file } : { which })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.success) {
          alert(data.error || 'Could not open that folder.');
        }
      } catch (err) {
        console.error('Open folder error:', err);
        alert('Could not reach the server to open that folder.');
      }
    }

    // Always re-read rather than trusting the copy in memory: in SHOWCASE_MODE the static
    // manifest is the only record of what got exported, and otherwise the folder on disk can
    // change behind this page either way.
    async function refreshHistory() {
      try {
        const res = await fetch(SHOWCASE_MODE ? 'dungeons.json' : `${SERVER_URL}/api/history`);
        const data = await res.json();
        historyEntries = Array.isArray(data.sessions) ? data.sessions : [];
        if (SHOWCASE_MODE) applyShowcaseOverlay(historyEntries);
      } catch (err) {
        console.error('History fetch error:', err);
        historyEntries = null;
      }
      renderHistoryList();
      if (SHOWCASE_MODE) renderShowcaseList();
    }

    function openHistory() {
      if (!modalHistory) return;
      modalHistory.classList.remove('hidden');
      // "Similar only" compares against the dungeon actually being played mid-run - at the
      // menu there is no run to compare against, only whatever is sitting in the mad-lib
      // fields (which may just be a different idea being drafted), so the checkbox is hidden
      // there rather than filtering the list against something that isn't really a "current
      // dungeon". historySimilarReference()'s own menu fallback is left in place - nothing
      // reads it while this is unchecked and hidden.
      if (historySimilarOnlyLabel) historySimilarOnlyLabel.classList.toggle('hidden', !currentRunHistoryId);
      if (!currentRunHistoryId && historySimilarOnly) historySimilarOnly.checked = false;
      syncHistorySimilarOnly();
      setHistoryMessage('Reading saved dungeons...');
      if (historyFootNote) historyFootNote.textContent = '';
      // Opened mid-run: the list that comes back should arrive scrolled to the dungeon being
      // played, not at the top. Nothing to reveal when the player is out at the main menu.
      historyRevealCurrent = !!currentRunHistoryId;
      // The rows are still being fetched, so park the cursor on OK; renderHistoryList moves
      // it up onto the first Start once there is a list to move onto.
      focusFirstIn(modalHistory, btnHistoryOk);
      refreshHistory();
      // The rows' movie buttons show whatever ending render is going - including one the server
      // started on its own at the end of a background-mode run, which this page never asked for.
      watchEndingJob();
    }

    function closeHistory() {
      if (modalHistory) modalHistory.classList.add('hidden');
      closeDeleteConfirm();
      closeLeaveRunConfirm();
      closeEndingPlayer();
      closeStopEndingFilm();
    }

    // ---- Leaving a live run from History ----------------------------------
    // History can be open right over a running game (the quit box's "Load a Different
    // Dungeon" opens it without leaving the run first), and both of a row's verbs end that
    // run: Start loads another dungeon over it, Prompts leaves it for the menu. So either one
    // asks in this box before it does. Out at the menu there is no run to lose, and both just go.
    const LEAVE_RUN_VERBS = {
      start: {
        icon: '▶️',
        go: 'Start',
        text: (entry) => (entry.id && entry.id === currentRunHistoryId)
          ? 'Starting this dungeon again ends your current run and reloads it from the beginning,'
            + ' on a freshly drawn maze. Your progress in this run is lost.'
          : 'Starting this dungeon ends your current run and loads the new one in its place.'
            + ' Your progress in this dungeon is lost, but the dungeon itself stays in History'
            + ' to Start again.',
        act: (entry) => loadHistoryDungeon(entry)
      },
      prompts: {
        icon: '📋',
        go: 'Continue',
        text: () => 'Using these prompts ends your current run and takes you back to the main'
          + ' menu to edit them. Your progress in this dungeon is lost, but the dungeon itself'
          + ' stays in History to Start again.',
        act: (entry) => applyHistoryPrompts(entry)
      }
    };

    // The verb and entry the box is currently asking about, or null.
    let leaveRunPending = null;

    function askLeaveRun(verbKey, entry) {
      const verb = LEAVE_RUN_VERBS[verbKey];
      if (!modalLeaveRunConfirm) { verb.act(entry); return; }
      leaveRunPending = { verb, entry };
      if (leaveRunConfirmIcon) leaveRunConfirmIcon.textContent = verb.icon;
      if (leaveRunConfirmName) {
        // Named by the run being ended, not the row that was clicked - that is what is lost.
        const where = (dungeonStory && dungeonStory.location) || currentThemeName || '';
        leaveRunConfirmName.textContent = where.trim();
      }
      if (leaveRunConfirmText) leaveRunConfirmText.textContent = verb.text(entry);
      if (btnLeaveRunConfirmContinue) btnLeaveRunConfirmContinue.textContent = verb.go;
      modalLeaveRunConfirm.classList.remove('hidden');
      // Cancel, never the go button: a stray Enter must not end the run.
      focusFirstIn(modalLeaveRunConfirm, btnLeaveRunConfirmCancel);
    }

    function closeLeaveRunConfirm() {
      const wasOpen = modalLeaveRunConfirm && !modalLeaveRunConfirm.classList.contains('hidden');
      leaveRunPending = null;
      if (modalLeaveRunConfirm) modalLeaveRunConfirm.classList.add('hidden');
      // Same hand-back as closeDeleteConfirm: the cursor returns to the list behind the box.
      if (wasOpen && modalHistory && !modalHistory.classList.contains('hidden')) {
        focusFirstIn(modalHistory, btnHistoryOk);
      }
    }

    function confirmLeaveRun() {
      const pending = leaveRunPending;
      closeLeaveRunConfirm();
      if (pending) pending.verb.act(pending.entry);
    }

    // ---- Starting a saved dungeon -----------------------------------------
    // The row's Start button. Out at the menu it loads straight away; over a live run it asks
    // first, since loading a dungeon throws away the one being played.
    function startHistoryDungeon(entry) {
      if (!entry) return;
      // A live generation owns the progress screen; don't let History yank it away.
      if (generationInFlight) {
        alert('A dungeon is still being generated. Let it finish first.');
        return;
      }
      if (!atBaseScreen()) {
        askLeaveRun('start', entry);
        return;
      }
      loadHistoryDungeon(entry);
    }

    // Deliberately walks the same path btnCreate does, minus the generation: same reset,
    // same screen swap, same freshly generated maze. The only differences are where the
    // bundle comes from and that the progress readout is already finished on arrival.
    async function loadHistoryDungeon(entry) {
      closeHistory();

      // Reachable straight from an active run (the quit-confirm box opens History without
      // leaving it first, and the player has said yes to ending it by now) - tear down
      // whatever it's replacing the same way openSetupScreen would.
      // resetCombatForNewDungeon/resetCrawl below cover the rest (defeat modal, narration,
      // screen music); these two don't.
      screenGame.classList.add('hidden');
      if (victoryModal) victoryModal.classList.add('hidden');
      stopOutroNarration();
      stopConfetti();
      resetEndingCutscene();
      crawlReadingUntil = 0;

      const wallStyle = entry.wall_style || 'Windows 95';
      // Same quote-marker strip as the create-dungeon path above - a replayed session's saved
      // wall_style can carry a quoted name too.
      currentThemeName = wallStyle.replace(/["“”]/g, "");
      activeMode = entry.mode || 'v6_krea';
      const numGrids = (DIFFICULTIES[selectedDifficulty] || DIFFICULTIES.medium).grids;

      resetCombatForNewDungeon();
      resetCrawl('LOADING ASSETS');
      hideBaseScreen();
      screenProgress.classList.remove('hidden');
      appContainer.className = 'win95-box p-1 text-black mode-progress';

      // The maze is never saved with the bundle, so a replay is the same cast on new ground,
      // sized by whatever difficulty is selected right now.
      generateAuthentic3DMaze(numGrids);
      buildExitStairsTexture(wallStyle, wallTexture);

      // Reading tens of megabytes back off disk is quick but not instant, so the screen says
      // what it is doing instead of sitting on a dead bar.
      const startTime = Date.now();
      progTimer.textContent = '0.0s';
      genClockTimer = setInterval(() => {
        progTimer.textContent = ((Date.now() - startTime) / 1000).toFixed(1) + 's';
      }, 100);
      if (progHeaderIcon) progHeaderIcon.textContent = '📜';
      if (progHeaderText) progHeaderText.textContent = 'Loading Saved Dungeon...';
      if (progPhaseText) progPhaseText.textContent = '';
      progStatusText.textContent = 'Reading ' + historyTitleOf(entry) + ' from history...';
      progPercentText.textContent = '0%';
      paintProgressChunks(0);
      setTabTitlePercent(0);

      try {
        const bundleUrl = SHOWCASE_MODE
          ? `dungeons/${encodeURIComponent(entry.id)}/bundle.json`
          : `${SERVER_URL}/api/history_bundle?id=${encodeURIComponent(entry.id)}`;
        const res = await fetch(bundleUrl);
        if (!res.ok) throw new Error('Could not read that saved dungeon.');
        const bundle = await res.json();
        stopGenerationTimers();
        // The title bar's ✕ can land while this read is in flight. It has already put the
        // menu back up, so this bundle is no longer wanted - arming ENTER now would chime and
        // start the narrator over a screen the player has left.
        if (screenProgress.classList.contains('hidden')) return;

        // Nothing to wait for: fill the bar, then hand the bundle to the same function the
        // poll loop uses. It starts the crawl, starts the narration, plays the ready chime
        // and arms ENTER - and pressing ENTER runs enterDungeon(), which stops the narrator
        // mid-sentence exactly as it does on a freshly generated run.
        progPercentText.textContent = '100%';
        paintProgressChunks(100);
        setTabTitlePercent(100);
        currentRunHistoryId = entry.id || null;
        currentRunFavorite = !!entry.favorite;
        currentRunHistoryPrompts = {
          wall: entry.wall_style || '', player: entry.player_style || '',
          weapon: entry.weapon_style || '', enemy: entry.enemy_style || ''
        };
        armEnterDungeon(bundle);
        if (progHeaderIcon) progHeaderIcon.textContent = '📜';
        if (progHeaderText) progHeaderText.textContent = 'Loaded from History!';
      } catch (err) {
        stopGenerationTimers();
        console.error('History load error:', err);
        // Same as above: if the ✕ already took the player off this screen, the failure is
        // moot - don't alert about a load nobody is waiting on any more.
        if (screenProgress.classList.contains('hidden')) return;
        alert('Could not load that saved dungeon - it may have been deleted.\n\n' + err.message);
        resetCrawl();
        resetTabTitle();
        screenProgress.classList.add('hidden');
        showBaseScreen();
        if (titleButtons) titleButtons.classList.remove('hidden');
        appContainer.className = 'win95-box p-1 text-black mode-setup w-full';
        // Whatever went wrong, the list this row came from is now out of date.
        refreshHistory();
      }
    }

    // ---- Reusing a saved dungeon's prompts --------------------------------
    // "Prompts" is the row's other verb: instead of replaying the run exactly as it was,
    // put the four things the player typed to make it back into the menu's mad-lib, so the
    // next dungeon can start from that wording with one word changed. Nothing generates and
    // nothing on disk is touched - this only writes the four inputs.
    //
    // The four fields are the TYPED words, not what the run became: the set designer's
    // resolved materials and the story's hero/foe names are shown on the row and in the
    // tooltips, but feeding those back in would generate from a different starting point
    // than the one that produced this dungeon.

    // The ✕ on each mad-lib line's image badge. An attached image blanks and disables its
    // field, so a slot holding one has to give the image up before saved wording can land
    // there. Routed through the badge's own button rather than reimplemented, so the
    // thumbnail, the file input and attachedImages all clear exactly as they do by hand.
    // The wall line takes no image and so has no entry here.
    const PROMPT_SLOT_CLEAR_BTN = {
      player: 'btnClearPlayerImage',
      weapon: 'btnClearWeaponImage',
      enemy: 'btnClearEnemyImage'
    };

    function fillPromptField(input, value, slotKey) {
      if (!input) return;
      if (input.disabled && slotKey) {
        const clearBtn = document.getElementById(PROMPT_SLOT_CLEAR_BTN[slotKey]);
        if (clearBtn) clearBtn.click();      // drops the image and re-enables the field
      }
      if (input.disabled) return;            // nothing freed it - don't report a fill that missed
      input.value = (value || '').trim();
      // Shared with undo/redo, which flashes the same fields for the same reason - see
      // flashPromptField up by the mad-lib history.
      flashPromptField(input);
    }

    function useHistoryPrompts(entry) {
      if (!entry) return;
      // A live generation is reading the very fields this would overwrite, and owns the
      // screen the menu would come back on. Same guard, same wording as Start above.
      if (generationInFlight) {
        alert('A dungeon is still being generated. Let it finish first.');
        return;
      }
      // Over a running game there is no menu behind History to write into, so this has to
      // end that run - and it asks before it does.
      if (screenSetup.classList.contains('hidden')) {
        askLeaveRun('prompts', entry);
        return;
      }
      applyHistoryPrompts(entry);
    }

    function applyHistoryPrompts(entry) {
      closeHistory();
      // Cleared before the openSetupScreen() call below rather than after: that call has its
      // own auto-refill for a run started from History (see currentRunHistoryPrompts), and
      // without this a "Prompts" press on such a run would fill the fields with the CURRENT
      // run's prompts as one undo step and then this entry's as a second, right on top of it.
      currentRunHistoryPrompts = null;
      // Leave for the menu exactly as the quit box's "Back to Main Menu" does. Only ever
      // reached mid-run once the player has said yes in the box above.
      if (screenSetup.classList.contains('hidden')) openSetupScreen();

      // One undo step for the whole refill, images dropped included - this overwrites four
      // fields at once, so walking it back has to put all four of them back at once too.
      asOneSetupStep(() => {
        fillPromptField(wallPromptInput, entry.wall_style, null);
        fillPromptField(playerPromptInput, entry.player_style, 'player');
        fillPromptField(weaponPromptInput, entry.weapon_style, 'weapon');
        fillPromptField(enemyPromptInput, entry.enemy_style, 'enemy');
      });

      // Same landing as a Quick idea: the top of the filled-in mad-lib, reading down, with
      // Enter from any field still firing CREATE. Clearing an attached image above focuses
      // that line's input, so this has to come last to win.
      if (wallPromptInput) wallPromptInput.focus({ preventScroll: true });
    }

    // ---- Deleting a saved dungeon -----------------------------------------
    // The trash can only ever opens this box; the delete itself lives behind its Delete
    // button, because what it erases cannot be got back without generating it all again.
    function askDeleteHistory(entry) {
      if (!entry || !modalHistoryConfirm) return;
      if (entry.favorite) return;   // the can is disabled on a favorite; this is the backstop
      historyPendingDelete = entry;
      if (historyConfirmName) {
        historyConfirmName.textContent = historyTitleOf(entry)
          + (entry.created_text ? '  —  ' + entry.created_text : '');
      }
      modalHistoryConfirm.classList.remove('hidden');
      // Cancel, never Delete: a box that erases on a stray Enter is a box that erases.
      focusFirstIn(modalHistoryConfirm, btnHistoryConfirmCancel);
    }

    function closeDeleteConfirm() {
      const wasOpen = modalHistoryConfirm && !modalHistoryConfirm.classList.contains('hidden');
      historyPendingDelete = null;
      if (modalHistoryConfirm) modalHistoryConfirm.classList.add('hidden');
      // Hiding the box that owns the focused button would drop focus on the document, and
      // the arrow keys would have nothing to move from - hand it back to the list behind it.
      if (wasOpen && modalHistory && !modalHistory.classList.contains('hidden')) {
        focusFirstIn(modalHistory, btnHistoryOk);
      }
    }

    async function confirmDeleteHistory() {
      const entry = historyPendingDelete;
      closeDeleteConfirm();
      if (!entry) return;
      // History can be opened right over a still-running game - the quit-confirm box's "Load a
      // Different Dungeon" does exactly that without tearing the run down first - so the row
      // being erased may be the run that is live behind this window.
      const erasingLiveRun = !!(entry.id && entry.id === currentRunHistoryId);
      // The list below is rebuilt from the server, which would put it back at the top; hold
      // the offset so the window the player is reading does not jump under them.
      const scrollBack = historyList ? historyList.scrollTop : 0;
      let deleted = true;
      try {
        const res = await fetch(`${SERVER_URL}/api/history_delete`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: entry.id })
        });
        const data = await res.json().catch(() => ({}));
        if (!data.success) throw new Error(data.error || 'The server refused the delete.');
      } catch (err) {
        console.error('History delete error:', err);
        deleted = false;
        alert('Could not delete that dungeon.\n\n' + err.message);
      }
      // Its bundle is gone from disk, so there is nothing left to keep playing: end the run
      // behind the window exactly as "Erase Current Run" does - but leave History itself open
      // and where it stands, since the player came here to pick a different dungeon and the
      // list they were choosing from is still the answer to that.
      if (erasingLiveRun && deleted) openSetupScreen();
      // Re-listing rather than splicing the row out keeps the window honest about what is
      // actually left on disk, whether the delete worked or not.
      await refreshHistory();
      if (historyList) historyList.scrollTop = scrollBack;
    }

    if (btnHistory) btnHistory.addEventListener('click', openHistory);
    if (btnCloseHistory) btnCloseHistory.addEventListener('click', closeHistory);
    if (btnHistoryOk) btnHistoryOk.addEventListener('click', closeHistory);
    if (historySimilarOnly) historySimilarOnly.addEventListener('change', renderHistoryList);
    if (btnOpenSessionsFolder) btnOpenSessionsFolder.addEventListener('click', () => openServerFolder('sessions'));
    if (btnOpenAssetsFolder) btnOpenAssetsFolder.addEventListener('click', () => openServerFolder('assets'));
    if (btnHistoryConfirmClose) btnHistoryConfirmClose.addEventListener('click', closeDeleteConfirm);
    if (btnHistoryConfirmCancel) btnHistoryConfirmCancel.addEventListener('click', closeDeleteConfirm);
    if (btnHistoryConfirmDelete) btnHistoryConfirmDelete.addEventListener('click', confirmDeleteHistory);
    if (btnLeaveRunConfirmClose) btnLeaveRunConfirmClose.addEventListener('click', closeLeaveRunConfirm);
    if (btnLeaveRunConfirmCancel) btnLeaveRunConfirmCancel.addEventListener('click', closeLeaveRunConfirm);
    if (btnLeaveRunConfirmContinue) btnLeaveRunConfirmContinue.addEventListener('click', confirmLeaveRun);
    // Clicking the darkened History list behind the box backs out, like the erase box does.
    if (modalLeaveRunConfirm) {
      modalLeaveRunConfirm.addEventListener('click', (e) => {
        if (e.target === modalLeaveRunConfirm) closeLeaveRunConfirm();
      });
    }

    // ESC backs out of the Options, About and History windows, the same as clicking their ✕. The
    // History delete-confirm sits on top of the list, so a first ESC closes just that and
    // leaves History open; a second ESC then closes History. While the screen saver is up its
    // own capture-phase key handler runs first and swallows the ESC to dismiss itself, so
    // this never fires over it.
    window.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' && e.code !== 'Escape') return;
      if (modalLoadingExitConfirm && !modalLoadingExitConfirm.classList.contains('hidden')) {
        // Backing out means carrying on generating / reading.
        e.preventDefault();
        closeLoadingExitConfirm();
      } else if (modalDownloadStopConfirm && !modalDownloadStopConfirm.classList.contains('hidden')) {
        // Backing out means Keep Downloading.
        e.preventDefault();
        closeStopModelDownload();
      } else if (modalEndingStopConfirm && !modalEndingStopConfirm.classList.contains('hidden')) {
        // Backing out means Keep Filming.
        e.preventDefault();
        closeStopEndingFilm();
      } else if (modalEndingPlayer && !modalEndingPlayer.classList.contains('hidden')) {
        // Stacked on History, so this ESC closes only the movie and leaves the list open.
        e.preventDefault();
        closeEndingPlayer();
      } else if (modalEraseConfirm && !modalEraseConfirm.classList.contains('hidden')) {
        // Only reached if the quit box underneath is somehow gone; normally the in-game
        // handler has already peeled this one off and stopped there.
        e.preventDefault();
        cancelEraseConfirm();
      } else if (modalHistoryConfirm && !modalHistoryConfirm.classList.contains('hidden')) {
        e.preventDefault();
        closeDeleteConfirm();
      } else if (modalLeaveRunConfirm && !modalLeaveRunConfirm.classList.contains('hidden')) {
        e.preventDefault();
        closeLeaveRunConfirm();
      } else if (modalSettings && !modalSettings.classList.contains('hidden')) {
        e.preventDefault();
        modalSettings.classList.add('hidden');
      } else if (modalAbout && !modalAbout.classList.contains('hidden')) {
        e.preventDefault();
        closeAbout();
      } else if (modalHistory && !modalHistory.classList.contains('hidden')) {
        e.preventDefault();
        closeHistory();
      } else if (!screenProgress.classList.contains('hidden')) {
        // Nothing else is up, so ESC on the loading screen is its title-bar ✕ - the same
        // pairing the dungeon screen has. Last in the chain so every open box wins first.
        e.preventDefault();
        openLoadingExitConfirm();
      }
    });

    // ==========================================
    // SCREEN SAVER - Windows 98 "Starfield Simulation"
    // ==========================================
    // A full-window black sheet that takes over after a stretch of doing nothing, with the
    // stars flying out of the middle exactly like the one that shipped with Win98. It only
    // ever appears when the machine is genuinely unattended: any pointer move, keypress,
    // button or typed character both resets the countdown and dismisses it, and narration,
    // a playing video and a live battle hold it off entirely (see screensaverBlocked).
    //
    // Everything drawn on it - stars, the generation readout, the story marquee - goes into
    // the single canvas, which is sized in CSS pixels and stretched by the browser, so the
    // global `image-rendering: pixelated` gives the whole thing the chunky low-res look of
    // the original instead of a crisp modern one.

    const screensaverEl = document.getElementById('screensaver');
    const starfieldCanvas = document.getElementById('starfieldCanvas');
    const starCtx = starfieldCanvas ? starfieldCanvas.getContext('2d') : null;
    const screensaverDelayInput = document.getElementById('screensaverDelay');
    const screensaverDelayText = document.getElementById('screensaverDelayText');

    // Slider stops, left to right. Index 0 is off; the default is index 2 (one minute).
    const SCREENSAVER_STOPS = [
      { secs: 0,    label: 'Disabled - the screen saver never starts.' },
      { secs: 30,   label: 'Starts after 30 seconds of idling.' },
      { secs: 60,   label: 'Starts after 1 minute of idling.' },
      { secs: 120,  label: 'Starts after 2 minutes of idling.' },
      { secs: 300,  label: 'Starts after 5 minutes of idling.' },
      { secs: 600,  label: 'Starts after 10 minutes of idling.' },
      { secs: 1800, label: 'Starts after 30 minutes of idling.' },
      { secs: 3600, label: 'Starts after 1 hour of idling.' }
    ];
    const SCREENSAVER_DEFAULT_STOP = 2;
    let screensaverDelayMs = SCREENSAVER_STOPS[SCREENSAVER_DEFAULT_STOP].secs * 1000;

    let screensaverActive = false;
    let screensaverLastActivity = Date.now();
    let screensaverRaf = null;
    let screensaverT0 = 0;
    // Input that lands before this timestamp neither dismisses the saver nor is swallowed.
    // Normally ~350ms from when it appears - long enough to eat the synthetic pointer move
    // some browsers fire on that same tick. A manual open from the title-bar ✕ stretches it
    // to a full second, so lifting the mouse off the button doesn't instantly close it.
    let screensaverGraceUntil = 0;
    // A manual open (the ✕ button) stays up even with the idle timeout set to Off. It still
    // yields to narration, a live battle or a playing video, the same as an idle open does.
    let screensaverForced = false;

    // ---- Stars -------------------------------------------------------------
    // Model space is a unit frustum: x and y in [-1, 1], z falling from 1 (the far plane,
    // where a star is a dim speck at the vanishing point) to 0 (the eye). The projection is
    // the plain x/z divide, so a star's screen distance from centre grows without bound as
    // it comes at you - which is the whole effect.
    const STAR_COUNT = 320;
    const STAR_SPEED = 0.34;      // depth units per second
    const STAR_NEAR = 0.035;      // recycled once nearer than this, before the divide explodes
    // The original's palette: white with a few cool and warm greys mixed in, never saturated.
    const STAR_TINTS = [
      [255, 255, 255], [255, 255, 255], [255, 255, 255],
      [216, 224, 255], [255, 240, 216], [192, 192, 192]
    ];
    const stars = [];

    function seedStar(st, atFarPlane) {
      st.x = (Math.random() * 2 - 1);
      st.y = (Math.random() * 2 - 1);
      // A fresh field is filled at every depth, or the first second is an empty screen;
      // recycled stars always come back in at the far plane.
      st.z = atFarPlane ? 1 : (STAR_NEAR + Math.random() * (1 - STAR_NEAR));
      st.tint = STAR_TINTS[(Math.random() * STAR_TINTS.length) | 0];
      return st;
    }
    for (let i = 0; i < STAR_COUNT; i++) stars.push(seedStar({}, false));

    function drawStarfield(w, h, dt) {
      const cx = w / 2, cy = h / 2;
      // One scale for both axes keeps the field circular rather than stretched to the window.
      // 0.26 is what makes the far plane land WELL inside the frame: at 0.5 the whole square
      // of spawn positions already fills the window, so stars appear spread out and drift off
      // the edge almost at once. This tucks them into the middle third, so each one visibly
      // accelerates out from the vanishing point - the actual effect being copied here.
      const scale = Math.max(w, h) * 0.26;
      for (let i = 0; i < stars.length; i++) {
        const st = stars[i];
        st.z -= STAR_SPEED * dt;
        if (st.z <= STAR_NEAR) { seedStar(st, true); continue; }
        const sx = cx + (st.x / st.z) * scale;
        const sy = cy + (st.y / st.z) * scale;
        // Off the edges it is gone for good - recycling it keeps the density even.
        if (sx < -8 || sx > w + 8 || sy < -8 || sy > h + 8) { seedStar(st, true); continue; }
        // Near stars are bigger and brighter; the far ones fade up out of the vanishing
        // point instead of popping into existence. The size ramp is near^1.5 rather than
        // near^2 - squared, almost every star stays a single pixel, because a star has to
        // be nearly dead centre to survive deep enough for the curve to lift it, and the
        // field ends up an even dusting with no sense of depth at all.
        const near = 1 - st.z;
        const size = 1 + Math.round(Math.pow(near, 1.5) * 3.5);
        const alpha = Math.min(1, 0.10 + near * 1.35);
        const t = st.tint;
        starCtx.fillStyle = 'rgba(' + t[0] + ',' + t[1] + ',' + t[2] + ',' + alpha.toFixed(3) + ')';
        starCtx.fillRect(Math.round(sx), Math.round(sy), size, size);
      }
    }

    // ---- Text drawn over the stars ----------------------------------------
    // Monospace, white on black, no panels: the readouts have to sit in the star field
    // without turning into a dialog box on top of it.
    function ssFont(px, bold) {
      return (bold ? 'bold ' : '') + px + 'px "Lucida Console", "Courier New", monospace';
    }

    function ssLine(text, x, y, px, alpha, opts) {
      const o = opts || {};
      starCtx.font = ssFont(px, o.bold !== false);
      starCtx.textAlign = o.align || 'center';
      starCtx.textBaseline = 'alphabetic';
      try { starCtx.letterSpacing = (o.spacing || 0) + 'px'; } catch (e) { /* older browsers */ }
      // A soft halo, so a star passing behind a glyph never eats it.
      starCtx.shadowColor = 'rgba(0,0,0,0.9)';
      starCtx.shadowBlur = 6;
      starCtx.fillStyle = 'rgba(' + (o.rgb || '255,255,255') + ',' + alpha + ')';
      starCtx.fillText(text, x, y);
      starCtx.shadowBlur = 0;
      try { starCtx.letterSpacing = '0px'; } catch (e) {}
    }

    // The Win95 install bar, redrawn in the star field's own palette: a sunken grey trough
    // of fixed-pitch blocks rather than a smooth modern fill.
    function ssProgressBar(cx, y, width, percent) {
      const h = 14, pitch = 12, chunkW = 10;
      const x = Math.round(cx - width / 2);
      starCtx.strokeStyle = 'rgba(160,160,160,0.75)';
      starCtx.lineWidth = 1;
      starCtx.strokeRect(x + 0.5, y + 0.5, width - 1, h - 1);
      const inner = width - 6;
      const maxChunks = Math.max(1, Math.floor(inner / pitch));
      const chunks = Math.round((Math.max(0, Math.min(100, percent)) / 100) * maxChunks);
      starCtx.fillStyle = 'rgba(255,255,255,0.92)';
      for (let i = 0; i < chunks; i++) {
        starCtx.fillRect(x + 3 + i * pitch, y + 3, chunkW, h - 6);
      }
    }

    // One line of text scrolling right to left, tiled so it never leaves a gap.
    function ssMarquee(w, h, text, t) {
      const px = Math.max(11, Math.min(19, Math.round(w / 60)));
      starCtx.font = ssFont(px, true);
      starCtx.textAlign = 'left';
      try { starCtx.letterSpacing = '0px'; } catch (e) {}
      const gap = px * 8;
      const span = starCtx.measureText(text).width + gap;
      const y = h - Math.round(px * 1.15);
      // A hairline rule above the band, so the marquee reads as part of the display.
      starCtx.fillStyle = 'rgba(255,255,255,0.16)';
      starCtx.fillRect(0, y - Math.round(px * 1.5), w, 1);
      starCtx.shadowColor = 'rgba(0,0,0,0.9)';
      starCtx.shadowBlur = 6;
      starCtx.fillStyle = 'rgba(255,255,255,0.88)';
      // ~7 characters a second: quick enough to read the whole line without waiting on it,
      // slow enough that the words are not a blur.
      let x = w - ((t * px * 7) % span);
      while (x > -span) { starCtx.fillText(text, x, y); x -= span; }
      starCtx.shadowBlur = 0;
    }

    // Clip a readout to the width the corner has, with an ellipsis: a long status message
    // must not run off the left edge of the screen. Measured with the same font AND letter
    // spacing it will be drawn at, or the fit is off by a pixel per character.
    function ssFit(text, px, spacing, maxW) {
      starCtx.font = ssFont(px, true);
      try { starCtx.letterSpacing = (spacing || 0) + 'px'; } catch (e) { /* older browsers */ }
      let out = text;
      if (starCtx.measureText(out).width > maxW) {
        while (out.length > 1 && starCtx.measureText(out + '...').width > maxW) out = out.slice(0, -1);
        out += '...';
      }
      try { starCtx.letterSpacing = '0px'; } catch (e) {}
      return out;
    }

    // Width of a readout as it will actually be drawn - font and letter spacing both set,
    // for the same reason ssFit measures that way.
    function ssTextWidth(text, px, spacing) {
      starCtx.font = ssFont(px, true);
      try { starCtx.letterSpacing = (spacing || 0) + 'px'; } catch (e) { /* older browsers */ }
      const wpx = starCtx.measureText(text).width;
      try { starCtx.letterSpacing = '0px'; } catch (e) {}
      return wpx;
    }

    // The live generation percent, read straight off the progress window's own readout so
    // the saver and the window behind it can never disagree.
    function ssGenerationPercent() {
      return parseInt((progPercentText && progPercentText.textContent) || '0', 10) || 0;
    }

    // ---- What each screen puts on the star field ---------------------------
    function ssGenerationOverlay(w, h, t) {
      const done = !!(pendingBundle && btnEnterDungeon && !btnEnterDungeon.disabled);
      const cx = w / 2;
      const baseY = Math.round(h * 0.70);
      const big = Math.max(26, Math.min(64, Math.round(w / 15)));
      const small = Math.max(10, Math.min(15, Math.round(w / 78)));

      if (done) {
        // Breathing rather than blinking - a hard blink over a moving star field reads as a
        // glitch, a slow pulse reads as "waiting for you".
        const pulse = 0.66 + 0.34 * Math.sin(t * 2.2);
        ssLine('DONE GENERATING ASSETS', cx, baseY, Math.round(big * 0.62), pulse, { spacing: 3 });
        const where = ((dungeonStory && dungeonStory.location) || '').trim();
        ssLine(where ? (where.toUpperCase() + ' IS WAITING') : 'THE DUNGEON IS WAITING',
               cx, baseY + small * 2.6, small, 0.72, { rgb: '200,214,255', spacing: 2 });
        ssLine('MOVE THE MOUSE OR PRESS A KEY TO RETURN', cx, h - small * 2.4, small, 0.45,
               { rgb: '176,176,176', spacing: 1 });
        return;
      }

      // No title, no bar - a corner readout on the stars rather than a loading screen. The
      // percent holds the bottom-right corner; the same three details the progress window is
      // showing (what the server is working on, the live sub-job, how long it has been
      // running) stack up from the bottom LEFT in the same face and size, so the two corners
      // read as one status bar across the foot of the star field.
      const pct = ssGenerationPercent();
      const pctSize = Math.max(16, Math.min(30, Math.round(w / 34)));
      const margin = Math.round(pctSize * 1.2);
      const lineH = Math.round(pctSize * 1.35);
      const pctLabel = pct + '%';
      ssLine(pctLabel, w - margin, h - margin, pctSize, 0.8, { align: 'right', spacing: 1 });

      const details = [];
      const ssStatus = ((progStatusText && progStatusText.textContent) || '').trim();
      const ssPhase = ((progPhaseText && progPhaseText.textContent) || '').trim();
      const ssElapsed = ((progTimer && progTimer.textContent) || '').trim();
      if (ssStatus) details.push(ssStatus.toUpperCase());
      if (ssPhase) details.push(ssPhase.toUpperCase());
      if (ssElapsed) details.push(ssElapsed.toUpperCase());
      // The last line shares the percent's baseline so the foot of the screen reads as one
      // row, with the rest of the detail stacked above it. Every line is clipped short of
      // the percent (plus a gap of its own) - that bottom one would otherwise run into it.
      const detailMaxW = Math.max(120, w - margin * 2
                                       - ssTextWidth(pctLabel, pctSize, 1) - pctSize * 1.5);
      let detailY = h - margin;
      for (let i = details.length - 1; i >= 0; i--) {
        ssLine(ssFit(details[i], pctSize, 1, detailMaxW), margin, detailY, pctSize, 0.55,
               { align: 'left', spacing: 1 });
        detailY -= lineH;
      }
    }

    function ssStoryMarqueeText() {
      const st = dungeonStory || {};
      const hero = (st.hero || '').trim() || 'the nameless warrior';
      const where = (st.location || currentThemeName || '').trim() || 'the dungeon';
      const boss = (st.boss || enemyBossName || '').trim();
      const won = !!(victoryModal && !victoryModal.classList.contains('hidden'));
      // A dead run must not still read "STILL WALKS ..." across the bottom of the screen -
      // the hero is face down in the maze and the marquee should say so throughout.
      const dead = !!combatState.dead;
      const sep = '   •   ';
      const parts = [];
      parts.push(dead
        ? hero.toUpperCase() + ' FELL IN ' + where.toUpperCase()
        : won
          ? hero.toUpperCase() + ' COMPLETES THE DUNGEON'
          : hero.toUpperCase() + ' STILL WALKS ' + where.toUpperCase());
      parts.push('LEVEL ' + progression.level);
      parts.push(Math.max(0, Math.round(combatState.playerHp)) + '/' + combatState.playerMaxHp + ' HP');
      parts.push(totalMoves + (totalMoves === 1 ? ' STEP TAKEN' : ' STEPS TAKEN'));
      if (passagesList.length) parts.push(visitedTiles.size + '/' + passagesList.length + ' TILES MAPPED');
      if (boss) {
        parts.push(bossDefeated
          ? hero.toUpperCase() + ' HAS DEFEATED ' + boss.toUpperCase()
          : boss.toUpperCase() + (dead ? ' WILL NEVER BE FOUGHT' : ' WAITS AT THE END'));
      }
      parts.push(dead
        ? 'THE DUNGEON KEEPS WHAT IT KILLS'
        : won ? 'THE DUNGEON REMEMBERS YOUR NAME' : 'THE DUNGEON IS HOLDING YOUR PLACE');
      return parts.join(sep) + sep;
    }

    function ssGameOverlay(w, h, t) {
      const st = dungeonStory || {};
      const hero = ((st.hero || '').trim() || 'the nameless warrior').toUpperCase();
      const where = ((st.location || currentThemeName || '').trim() || 'the dungeon').toUpperCase();
      const cx = w / 2;
      const big = Math.max(20, Math.min(46, Math.round(w / 21)));
      const small = Math.max(10, Math.min(15, Math.round(w / 78)));
      const baseY = Math.round(h * 0.68);
      if (combatState.dead) {
        // The player went down and then walked away from the death box - the saver owes
        // them a verdict, not their hero's name pulsing away as if the run were still on.
        // Red, and only a slow throb so it reads as a dead sign flickering rather than a
        // frozen caption; the hero / level / place drop underneath in muted grey.
        ssLine('YOU DIED', cx, baseY, big, 0.74 + 0.18 * Math.sin(t * 1.7),
               { rgb: '255,82,82', spacing: 8 });
        ssLine(hero + '  •  LEVEL ' + progression.level + '  •  ' + where,
               cx, baseY + small * 2.4, small, 0.58, { rgb: '224,178,178', spacing: 2 });
        ssMarquee(w, h, ssStoryMarqueeText(), t);
        return;
      }
      // The name drifts in brightness, so a player who has stopped moving still sees the
      // screen doing something with their hero rather than a frozen caption.
      ssLine(hero, cx, baseY, big, 0.72 + 0.2 * Math.sin(t * 1.1), { spacing: 3 });
      ssLine('LEVEL ' + progression.level + '  •  ' + where, cx, baseY + small * 2.4, small,
             0.66, { rgb: '200,214,255', spacing: 2 });
      ssMarquee(w, h, ssStoryMarqueeText(), t);
    }

    function ssSetupOverlay(w, h, t) {
      const cx = w / 2;
      ssLine('COMFYCRAWLER', cx, Math.round(h * 0.70),
             Math.max(20, Math.min(44, Math.round(w / 22))),
             0.66 + 0.24 * Math.sin(t * 1.1), { spacing: 6 });
      ssMarquee(w, h,
        'COMFYCRAWLER   •   A 3D DUNGEON BUILT OUT OF WHATEVER YOU TYPE   •   ' +
        'MOVE THE MOUSE OR PRESS A KEY TO RETURN   •   ', t);
    }

    // ---- Frame -------------------------------------------------------------
    function sizeStarfield() {
      if (!starfieldCanvas) return;
      // Deliberately backed at CSS-pixel size (no devicePixelRatio): on a hi-dpi screen the
      // browser scales it up under `image-rendering: pixelated`, which is exactly the coarse
      // pixel grid the 1998 original ran on.
      const w = Math.max(1, window.innerWidth);
      const h = Math.max(1, window.innerHeight);
      if (starfieldCanvas.width !== w) starfieldCanvas.width = w;
      if (starfieldCanvas.height !== h) starfieldCanvas.height = h;
    }

    let ssLastFrame = 0;
    function screensaverFrame(now) {
      if (!screensaverActive) { screensaverRaf = null; return; }
      screensaverRaf = requestAnimationFrame(screensaverFrame);
      // Shares the viewport's frame budget - the starfield is the only thing drawing while it
      // is up, and it is a full-window canvas, so the cap means what it says here too. Gated
      // before ssLastFrame moves, so a skipped frame still hands its milliseconds to the next
      // one and the warp keeps its real-time speed.
      if (!viewportFrameAllowed(now)) return;
      sizeStarfield();
      const w = starfieldCanvas.width, h = starfieldCanvas.height;
      // Clamped, so a tab that was backgrounded doesn't warp the whole field forward at once.
      const dt = Math.min(0.05, Math.max(0, (now - ssLastFrame) / 1000));
      ssLastFrame = now;
      const t = (now - screensaverT0) / 1000;

      starCtx.fillStyle = '#000000';
      starCtx.fillRect(0, 0, w, h);
      drawStarfield(w, h, dt);

      if (!screenProgress.classList.contains('hidden')) ssGenerationOverlay(w, h, t);
      else if (!screenGame.classList.contains('hidden')) ssGameOverlay(w, h, t);
      else ssSetupOverlay(w, h, t);
    }

    // ---- Show / hide / idle ------------------------------------------------
    function showScreensaver() {
      if (screensaverActive || !screensaverEl || !starCtx) return;
      screensaverActive = true;
      screensaverGraceUntil = Date.now() + 350;
      sizeStarfield();
      // A fresh field every time, so it always opens on the same sparse warp.
      for (let i = 0; i < stars.length; i++) seedStar(stars[i], false);
      screensaverEl.classList.remove('hidden');
      screensaverT0 = ssLastFrame = performance.now();
      screensaverRaf = requestAnimationFrame(screensaverFrame);
    }

    // The title-bar ✕ routes here (off the game screen): "closing" the window just hands the
    // whole screen to the starfield. Unlike an idle open it ignores a zero (Off) timeout, but
    // it still defers to anything that means the machine is in use, and it widens the input
    // grace to a second so the mouse leaving the ✕ doesn't dismiss it on the same gesture.
    function showScreensaverManually() {
      screensaverForced = true;
      if (screensaverBlocked()) { screensaverForced = false; return; }
      showScreensaver();
      if (!screensaverActive) { screensaverForced = false; return; }
      screensaverGraceUntil = Date.now() + 1000;
    }

    function hideScreensaver() {
      if (!screensaverActive) return;
      screensaverActive = false;
      screensaverForced = false;
      if (screensaverRaf) { cancelAnimationFrame(screensaverRaf); screensaverRaf = null; }
      if (screensaverEl) screensaverEl.classList.add('hidden');
      screensaverLastActivity = Date.now();
    }

    function ssAudioPlaying(el) {
      return !!(el && el.src && !el.paused && !el.ended);
    }

    function ssVideoPlaying() {
      const vids = document.querySelectorAll('video');
      for (let i = 0; i < vids.length; i++) {
        const v = vids[i];
        if (!v.paused && !v.ended && v.readyState > 2) return true;
      }
      return false;
    }

    // Anything here means the machine is not actually unattended, so the countdown is held
    // at zero rather than merely paused - the full wait has to elapse after it clears.
    function screensaverBlocked() {
      // A manual open from the ✕ overrides only the Off setting - every check below still applies.
      if (screensaverDelayMs <= 0 && !screensaverForced) return true;
      if (narrationActive() || ssAudioPlaying(narrateAudio) || ssAudioPlaying(outroAudio)) return true;
      // The intro crawl's own scroll duration, independent of narration - covers a story
      // that shipped with no audio at all, or whose autoplay got blocked before a click
      // retried it. Without this the crawl text itself has nothing blocking the saver.
      if (Date.now() < crawlReadingUntil) return true;
      // A battle is real time - the foe keeps swinging between keypresses - so it counts as
      // the game being played throughout. Once the player is down it stops counting.
      if (combatState.inBattle && !combatState.dead) return true;
      if (ssVideoPlaying()) return true;
      // The opening stretch of a generation run: the story crawl is still landing, the first
      // models are loading and the bar has barely moved. Blanking the screen over that reads
      // as the run having stalled, so hold the saver off until it is genuinely 10% in - after
      // which the wait is long and uneventful enough that the starfield is the better view.
      if (!screenProgress.classList.contains('hidden') && ssGenerationPercent() < 10) return true;
      return false;
    }

    function noteScreensaverActivity(e) {
      screensaverLastActivity = Date.now();
      if (!screensaverActive) return;
      // Input inside the grace window is ignored, not consumed: it covers the synthetic move
      // some browsers fire on the tick the overlay appears (~350ms), and the second-long hold
      // after a manual open from the ✕ button so the mouse leaving it doesn't dismiss it.
      if (Date.now() < screensaverGraceUntil) return;
      hideScreensaver();
      // The input that woke the machine is spent waking it: it must not also type a
      // character into the prompt behind the overlay or take a step in the dungeon.
      if (e) {
        if (e.cancelable) e.preventDefault();
        e.stopPropagation();
        if (e.stopImmediatePropagation) e.stopImmediatePropagation();
      }
    }

    // Capture phase on window, so this runs before game.js's own key handlers (which are
    // bubble-phase on window) and can swallow the waking keypress.
    ['pointerdown', 'pointermove', 'pointerup', 'mousedown', 'mousemove', 'wheel',
     'touchstart', 'touchmove', 'keydown', 'keyup', 'input', 'paste'
    ].forEach(type => window.addEventListener(type, noteScreensaverActivity,
                                              { capture: true, passive: false }));

    window.addEventListener('resize', () => { screensaverLastActivity = Date.now(); sizeStarfield(); });

    setInterval(() => {
      if (screensaverBlocked()) {
        // Never leave it up once something starts talking or a fight begins.
        if (screensaverActive) hideScreensaver();
        screensaverLastActivity = Date.now();
        return;
      }
      if (screensaverActive) return;
      if (Date.now() - screensaverLastActivity >= screensaverDelayMs) showScreensaver();
    }, 500);

    // ---- The Options slider ------------------------------------------------
    // The chosen stop sticks across reloads via localStorage - a screen-saver wait is a
    // set-once preference. A missing, unparseable or out-of-range value (first run, cleared
    // storage, a private window, a build with fewer stops) falls back to the one-minute
    // default; storage being unavailable entirely is swallowed, the setting just won't save.
    const SCREENSAVER_STOP_KEY = 'comfycrawler.screensaverStop';

    function clampScreensaverStop(idx) {
      return Math.max(0, Math.min(SCREENSAVER_STOPS.length - 1, idx | 0));
    }

    function loadScreensaverStop() {
      const raw = prefs.get(SCREENSAVER_STOP_KEY);
      if (raw === null) return SCREENSAVER_DEFAULT_STOP;
      const i = parseInt(raw, 10);
      return (Number.isNaN(i) || i < 0 || i >= SCREENSAVER_STOPS.length)
        ? SCREENSAVER_DEFAULT_STOP : i;
    }

    function saveScreensaverStop(idx) {
      prefs.set(SCREENSAVER_STOP_KEY, String(clampScreensaverStop(idx)));
    }

    function applyScreensaverStop(idx) {
      const i = clampScreensaverStop(idx);
      screensaverDelayMs = SCREENSAVER_STOPS[i].secs * 1000;
      if (screensaverDelayText) screensaverDelayText.textContent = SCREENSAVER_STOPS[i].label;
      if (screensaverDelayMs <= 0 && screensaverActive) hideScreensaver();
      screensaverLastActivity = Date.now();
    }

    // ---- Max frame rate ----------------------------------------------------
    // Sticks across reloads for the same reason the screensaver wait does: it is a property of
    // the machine the game is being played on, not of the dungeon being played.
    const maxFpsSlider = document.getElementById('maxFpsSlider');
    const maxFpsValue = document.getElementById('maxFpsValue');

    function loadFpsCap() {
      const raw = prefs.get(FPS_CAP_KEY);
      return raw === null ? DEFAULT_FPS_CAP : clampFpsCap(raw);
    }

    function saveFpsCap(v) {
      prefs.set(FPS_CAP_KEY, String(clampFpsCap(v)));
    }

    function showFpsCap(v) {
      applyFpsCap(v);
      if (maxFpsValue) maxFpsValue.textContent = `${maxFps} FPS`;
    }

    if (maxFpsSlider) {
      // The slider's value is a FPS_STOPS index, not an fps - that is what makes it notched:
      // every position on the track is one of the rates, and dragging steps between them
      // instead of sliding through the numbers in between.
      maxFpsSlider.min = '0';
      maxFpsSlider.max = String(FPS_STOPS.length - 1);
      maxFpsSlider.step = '1';
      const startFps = loadFpsCap();
      maxFpsSlider.value = String(fpsStopIndex(startFps));
      const showSliderFps = () => {
        const fps = FPS_STOPS[Number(maxFpsSlider.value)] || DEFAULT_FPS_CAP;
        showFpsCap(fps);
        saveFpsCap(fps);
        maxFpsSlider.setAttribute('aria-valuetext', `${fps} FPS`);
      };
      maxFpsSlider.addEventListener('input', showSliderFps);
      showFpsCap(startFps);
      maxFpsSlider.setAttribute('aria-valuetext', `${maxFps} FPS`);
    } else {
      applyFpsCap(loadFpsCap());
    }

    if (screensaverDelayInput) {
      const startStop = loadScreensaverStop();
      screensaverDelayInput.value = String(startStop);
      screensaverDelayInput.addEventListener('input', () => {
        const i = parseInt(screensaverDelayInput.value, 10);
        applyScreensaverStop(i);
        saveScreensaverStop(i);
      });
      applyScreensaverStop(startStop);
    }

    // Boot engine
    if (SHOWCASE_MODE) {
      // None of watchForSettling/watchEndingJob/watchDownloadJob/checkPreflight below have a
      // server to reach in this export - they already fail soft (each catches its own network
      // error), but skipping them outright keeps this page's network traffic honestly empty
      // instead of four failed requests on every load.
      if (btnOpenSessionsFolder) btnOpenSessionsFolder.classList.add('hidden');
      if (btnOpenAssetsFolder) btnOpenAssetsFolder.classList.add('hidden');
      if (btnQuitEraseRun) btnQuitEraseRun.classList.add('hidden');
      // Options, trimmed to what still means something without ComfyUI: Difficulty, Max Frame
      // Rate and Screensaver Wait stay; Graphics, Sound Generation, Ending Video and the ComfyUI
      // Connection fields are all generation-only, so they're replaced with one note pointing at
      // the repo for anyone who wants the real thing.
      const gfxQualityRow = document.getElementById('gfxQualityRow');
      const soundAndEndingRow = document.getElementById('soundAndEndingRow');
      const comfySettingsSection = document.getElementById('comfySettingsSection');
      const showcaseGenerateNote = document.getElementById('showcaseGenerateNote');
      const aboutModelsSection = document.getElementById('aboutModelsSection');
      if (gfxQualityRow) gfxQualityRow.classList.add('hidden');
      if (soundAndEndingRow) soundAndEndingRow.classList.add('hidden');
      if (comfySettingsSection) comfySettingsSection.classList.add('hidden');
      if (showcaseGenerateNote) showcaseGenerateNote.classList.remove('hidden');
      if (aboutModelsSection) aboutModelsSection.classList.add('hidden');
      screenSetup.classList.add('hidden');
      if (screenShowcase) screenShowcase.classList.remove('hidden');
      refreshHistory();
    } else {
      // Catches the reload-out-of-a-cancel case: this page is brand new, but the server may
      // still be stopping the run the previous page abandoned on its way out.
      watchForSettling();
      // ...and the reload-in-the-middle-of-a-movie case: an ending movie asked for from History
      // may still be filming, and CREATE / Fill-in have to come up greyed out until it is done.
      watchEndingJob();
      // ...and a model download still going from before a reload.
      watchDownloadJob();
      // ...and whether this machine's ComfyUI can make a dungeon at all (see checkPreflight).
      checkPreflight();
    }
    buildDefaultTextures();
    generateAuthentic3DMaze(DIFFICULTIES.medium.grids);
    render3D();
    drawMinimap();
    updateHUD();
